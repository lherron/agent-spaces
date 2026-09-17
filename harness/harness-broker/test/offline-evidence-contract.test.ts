import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../src/event-ledger'

const REPO_ROOT = resolve(import.meta.dir, '../../..')
const RELEASE_ENTRY = join(REPO_ROOT, 'scripts/asp-release/entries/harness-broker.ts')
const RELEASE = {
  releaseId: 'asp-offline-contract-test',
  sourceCommit: 'a'.repeat(40),
  builtAt: '2026-09-17T04:00:00.000Z',
}
const SCHEMA = 'harness-broker.offline-evidence/v1'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'offline-evidence-contract-'))
  roots.push(root)
  return root
}

function event(
  invocationId: string,
  seq: number,
  message = `event-${seq}`
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(seq * 1000).toISOString(),
    type: 'diagnostic',
    payload: { level: 'info', message },
  } as InvocationEventEnvelope
}

async function runReader(input: {
  request: Record<string, unknown>
  ledgerPath?: string
  indexPath?: string
}): Promise<{ exitCode: number; stdout: string; response: any }> {
  const child = Bun.spawn(
    [
      'bun',
      `--define=ASP_RELEASE_EMBEDDED_IDENTITY=${JSON.stringify(RELEASE)}`,
      RELEASE_ENTRY,
      'evidence-read',
      ...(input.ledgerPath === undefined ? [] : ['--event-ledger', input.ledgerPath]),
      ...(input.indexPath === undefined ? [] : ['--index', input.indexPath]),
    ],
    { cwd: REPO_ROOT, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }
  )
  child.stdin.write(`${JSON.stringify(input.request)}\n`)
  child.stdin.end()
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]).then(([code, text]) => [code, text] as const)
  return { exitCode, stdout, response: JSON.parse(stdout.trim()) }
}

describe('offline evidence integrity contract', () => {
  test('comparison oracle stays import-disjoint from production normalizers', () => {
    const source = readFileSync(
      join(REPO_ROOT, 'harness/harness-broker/src/offline-provider-comparison.ts'),
      'utf8'
    )
    for (const forbidden of [
      '/drivers/',
      '/capture/',
      'event-map',
      'event-normalize',
      'raw-journal',
      'capture-gate',
    ]) {
      expect(source).not.toMatch(
        new RegExp(`from\\s+['\"][^'\"]*${forbidden.replaceAll('/', '\\/')}[^'\"]*['\"]`)
      )
    }
  })

  test('torn final data is reported without repair while interior corruption returns no rows', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_integrity', 1))
    ledger.close()
    appendFileSync(ledgerPath, '{"invocationId":"inv_integrity"')
    const tornBytes = readFileSync(ledgerPath)

    const torn = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_integrity',
        afterSeq: 0,
      },
    })
    expect(torn.exitCode).toBe(0)
    expect(torn.response).toMatchObject({
      ok: true,
      result: { events: [expect.objectContaining({ seq: 1 })] },
      integrity: {
        status: 'torn_tail',
        byteLength: tornBytes.length,
        trailingBytes: expect.any(Number),
        lastIntact: { invocationId: 'inv_integrity', seq: 1 },
      },
    })
    expect(readFileSync(ledgerPath)).toEqual(tornBytes)

    writeFileSync(
      ledgerPath,
      `${JSON.stringify(event('inv_integrity', 1))}\nnot-json\n${JSON.stringify(event('inv_integrity', 2))}\n`
    )
    const corrupt = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_integrity',
        afterSeq: 0,
      },
    })
    expect(corrupt.exitCode).toBe(2)
    expect(corrupt.response).toMatchObject({
      ok: false,
      error: {
        code: 'ledger_corrupt',
        data: {
          byteOffset: expect.any(Number),
          lastIntactByteOffset: expect.any(Number),
          lastIntact: { invocationId: 'inv_integrity', seq: 1 },
        },
      },
    })
    expect(corrupt.response.result).toBeUndefined()
  })

  test('conflicting duplicate sequences fail with both byte offsets', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_duplicate', 1))
    ledger.close()
    appendFileSync(ledgerPath, `${JSON.stringify(event('inv_duplicate', 1, 'different'))}\n`)

    const run = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_duplicate',
        afterSeq: 0,
      },
    })
    expect(run.exitCode).toBe(2)
    expect(run.response).toMatchObject({
      ok: false,
      error: {
        code: 'ledger_conflicting_duplicate',
        data: {
          invocationId: 'inv_duplicate',
          seq: 1,
          firstByteOffset: 0,
          duplicateByteOffset: expect.any(Number),
        },
      },
    })
  })

  test('provider pages stop before maxBytes and reject changed snapshots', async () => {
    const root = scratch()
    const artifactPath = join(root, 'codex.jsonl')
    const rows = [1, 2, 3].map((seq) => ({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${seq}:${'x'.repeat(28_000)}` }],
      },
    }))
    writeFileSync(artifactPath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`)

    const first = await runReader({
      request: {
        schema: SCHEMA,
        operation: 'providerObservations',
        artifactPath,
        afterLine: 0,
        limit: 1000,
        maxBytes: 65_536,
        brokerEvents: [],
      },
    })
    expect(first.exitCode).toBe(0)
    expect(Buffer.byteLength(first.stdout)).toBeLessThanOrEqual(65_536)
    expect(first.response.page.scannedThroughLine).toBeGreaterThan(0)
    expect(first.response.page).toMatchObject({ hasMore: true })

    appendFileSync(artifactPath, `${JSON.stringify(rows[0])}\n`)
    const changed = await runReader({
      request: {
        schema: SCHEMA,
        operation: 'providerObservations',
        artifactPath,
        afterLine: first.response.page.scannedThroughLine,
        limit: 1,
        brokerEvents: [],
        snapshot: first.response.snapshot,
      },
    })
    expect(changed.exitCode).toBe(2)
    expect(changed.response).toMatchObject({
      ok: false,
      error: { code: 'provider_artifact_snapshot_unstable' },
    })
  })

  test('event maxBytes applies to the exact newline-terminated final response', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_exact_cap', 10, 'x'.repeat(100_000)))
    ledger.close()

    const unbounded = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_exact_cap',
        afterSeq: 9,
        maxBytes: 200_000,
      },
    })
    const exactBytes = Buffer.byteLength(unbounded.stdout)
    expect(unbounded.response).toMatchObject({ ok: true, hasMore: false, nextAfterSeq: 10 })

    const exact = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_exact_cap',
        afterSeq: 9,
        maxBytes: exactBytes,
      },
    })
    expect(exact.exitCode).toBe(0)
    expect(Buffer.byteLength(exact.stdout)).toBe(exactBytes)
    expect(exact.response).toMatchObject({ ok: true, hasMore: false, nextAfterSeq: 10 })

    const oneByteShort = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_exact_cap',
        afterSeq: 9,
        maxBytes: exactBytes - 1,
      },
    })
    expect(oneByteShort.exitCode).toBe(2)
    expect(oneByteShort.response).toMatchObject({
      ok: false,
      error: {
        code: 'offline_record_too_large',
        data: { kind: 'event', seq: 10, bytes: exactBytes, maxBytes: exactBytes - 1 },
      },
    })
  })

  test('filtered EOF advances across a cursor digit boundary within maxBytes', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_filtered_digits', 9))
    await ledger.append(event('inv_filtered_digits', 10))
    ledger.close()

    const run = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_filtered_digits',
        afterSeq: 8,
        types: ['turn.completed'],
        maxBytes: 65_536,
      },
    })
    expect(run.exitCode).toBe(0)
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(65_536)
    expect(run.response).toMatchObject({
      ok: true,
      result: { events: [] },
      hasMore: false,
      nextAfterSeq: 10,
    })
  })

  test('invalid, unsupported, unknown, and mixed-provider rows remain comparison-only', async () => {
    const root = scratch()
    const artifactPath = join(root, 'mixed.jsonl')
    writeFileSync(
      artifactPath,
      `${[
        'not-json',
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'function_call', call_id: 'unsupported', name: 'web_search' },
        }),
        JSON.stringify({ type: 'future_provider_record', payload: {} }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Claude text' }] },
        }),
      ].join('\n')}\n`
    )

    const run = await runReader({
      request: {
        schema: SCHEMA,
        operation: 'providerObservations',
        artifactPath,
        afterLine: 0,
        limit: 100,
        brokerEvents: [],
      },
    })
    expect(run.exitCode).toBe(0)
    expect(run.response).toMatchObject({
      ok: true,
      provider: 'unknown',
      counts: {
        invalidJsonRecords: 1,
        unsupportedRecords: 1,
        unknownRecords: 1,
        applicableObservations: 1,
      },
    })
    expect(run.response.observations).toHaveLength(1)
    expect(run.response.observations[0]).not.toHaveProperty('invocationId')
    expect(run.response.observations[0]).not.toHaveProperty('seq')
  })
})
