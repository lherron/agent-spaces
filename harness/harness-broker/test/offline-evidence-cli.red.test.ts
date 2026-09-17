import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../src/event-ledger'

// T-08565 red contract: exercise the one-shot executable seam. Do not import a
// future reader module here; these tests must keep specifying observable CLI
// behavior if its implementation is later reorganized.
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const CHECKOUT_CLI = join(REPO_ROOT, 'harness/harness-broker/bin/harness-broker.js')
const RELEASE_ENTRY = join(REPO_ROOT, 'scripts/asp-release/entries/harness-broker.ts')
const RELEASE = {
  releaseId: 'asp-90dd75083a32-20260917T040000Z-red001',
  sourceCommit: '90dd75083a32a78f07c8dc2358175db799e94475',
  builtAt: '2026-09-17T04:00:00.000Z',
}
const SCHEMA = 'harness-broker.offline-evidence/v1'

type ReaderRun = {
  exitCode: number
  stdout: string
  stderr: string
  lines: unknown[]
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'offline-evidence-cli-red-'))
  roots.push(root)
  return root
}

function event(invocationId: string, seq: number): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(seq * 1000).toISOString(),
    type: 'diagnostic',
    payload: { level: 'info', message: `committed-${seq}` },
  } as InvocationEventEnvelope
}

async function runReader(input: {
  request: Record<string, unknown>
  eventLedger?: string
  index?: string
  embedded?: boolean
  env?: Record<string, string>
}): Promise<ReaderRun> {
  const command = input.embedded === false ? CHECKOUT_CLI : RELEASE_ENTRY
  const args = [
    'bun',
    ...(input.embedded === false
      ? []
      : [`--define=ASP_RELEASE_EMBEDDED_IDENTITY=${JSON.stringify(RELEASE)}`]),
    command,
    'evidence-read',
    ...(input.eventLedger === undefined ? [] : ['--event-ledger', input.eventLedger]),
    ...(input.index === undefined ? [] : ['--index', input.index]),
  ]
  const child = Bun.spawn(args, {
    cwd: REPO_ROOT,
    env: { ...process.env, ...input.env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  child.stdin.write(`${JSON.stringify(input.request)}\n`)
  child.stdin.end()
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  const lines = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown)
  return { exitCode, stdout, stderr, lines }
}

function hashes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name)
        const digest = createHash('sha256').update(readFileSync(path)).digest('hex')
        return [name, `${statSync(path).size}:${digest}`]
      })
  )
}

describe('T-08565 offline evidence executable contract', () => {
  test('a checkout reader is typed unsupported and process environment cannot spoof release identity', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_checkout', 1))
    ledger.close()

    const run = await runReader({
      embedded: false,
      eventLedger: ledgerPath,
      index: indexPath,
      env: {
        ASP_RELEASE_ID: 'asp-env-must-not-win',
        ASP_RELEASE_SOURCE_COMMIT: 'f'.repeat(40),
      },
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_checkout',
        afterSeq: 0,
      },
    })

    expect(run.exitCode).toBe(2)
    expect(run.lines).toEqual([
      expect.objectContaining({
        schema: SCHEMA,
        ok: false,
        operation: 'eventsSince',
        error: expect.objectContaining({ code: 'offline_schema_unsupported' }),
      }),
    ])
    expect(run.stdout).not.toContain('asp-env-must-not-win')
  })

  test('the release reader is one-shot, returns its embedded identity, and reads committed envelopes', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_one_shot', 1))
    ledger.close()

    const run = await runReader({
      eventLedger: ledgerPath,
      index: indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_one_shot',
        afterSeq: 0,
      },
    })

    expect(run.exitCode).toBe(0)
    expect(run.lines).toHaveLength(1)
    expect(run.lines[0]).toMatchObject({
      schema: SCHEMA,
      ok: true,
      operation: 'eventsSince',
      release: RELEASE,
      result: {
        events: [expect.objectContaining({ invocationId: 'inv_one_shot', seq: 1 })],
        currentSeq: 1,
        retentionFloorSeq: 0,
      },
      hasMore: false,
      nextAfterSeq: 1,
      integrity: { status: 'intact' },
    })
  })

  test('unknown control operations and follow properties fail closed without mutating or creating files', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(event('inv_closed', 1))
    await ledger.ackEvents('inv_closed' as InvocationId, 1)
    ledger.close()
    const before = hashes(root)

    for (const request of [
      { schema: SCHEMA, operation: 'ackEvents', invocationId: 'inv_closed', throughSeq: 1 },
      {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_closed',
        afterSeq: 0,
        live: true,
      },
    ]) {
      const run = await runReader({ request, eventLedger: ledgerPath, index: indexPath })
      expect(run.exitCode).toBe(2)
      expect(run.lines).toEqual([
        expect.objectContaining({
          schema: SCHEMA,
          ok: false,
          error: expect.objectContaining({ code: 'invalid_request' }),
        }),
      ])
    }

    expect(hashes(root)).toEqual(before)
  })
})
