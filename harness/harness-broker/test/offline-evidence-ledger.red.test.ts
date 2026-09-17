import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../src/event-ledger'

// T-08565 behavior reds intentionally drive the real ledger writer and the
// public release executable. The private NDJSON/SQLite layouts are setup data,
// never a contract asserted by these tests.
const REPO_ROOT = resolve(import.meta.dir, '../../..')
const RELEASE_ENTRY = join(REPO_ROOT, 'scripts/asp-release/entries/harness-broker.ts')
const RELEASE = {
  releaseId: 'asp-90dd75083a32-20260917T040000Z-red001',
  sourceCommit: '90dd75083a32a78f07c8dc2358175db799e94475',
  builtAt: '2026-09-17T04:00:00.000Z',
}
const SCHEMA = 'harness-broker.offline-evidence/v1'
const roots: string[] = []

type Success = {
  ok: true
  release: typeof RELEASE
  result: { events: InvocationEventEnvelope[]; currentSeq: number; retentionFloorSeq: number }
  hasMore: boolean
  nextAfterSeq: number
  snapshot: unknown
  integrity: { status: 'intact' | 'torn_tail' }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'offline-evidence-ledger-red-'))
  roots.push(root)
  return root
}

function event(
  invocationId: string,
  seq: number,
  type: InvocationEventEnvelope['type'] = 'diagnostic',
  payload: Record<string, unknown> = { level: 'info', message: `event-${seq}` }
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: new Date(seq * 1000).toISOString(),
    type,
    payload,
  } as InvocationEventEnvelope
}

async function runReader(input: {
  ledgerPath: string
  indexPath: string
  request: Record<string, unknown>
}): Promise<{ exitCode: number; stdout: string; response: any }> {
  const child = Bun.spawn(
    [
      'bun',
      `--define=ASP_RELEASE_EMBEDDED_IDENTITY=${JSON.stringify(RELEASE)}`,
      RELEASE_ENTRY,
      'evidence-read',
      '--event-ledger',
      input.ledgerPath,
      '--index',
      input.indexPath,
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
  const response = stdout.trim() === '' ? undefined : JSON.parse(stdout.trim())
  return { exitCode, stdout, response }
}

function sourceHashes(root: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .map((name) => {
        const path = join(root, name)
        return [name, createHash('sha256').update(readFileSync(path)).digest('hex')]
      })
  )
}

async function readAllPages(input: {
  ledgerPath: string
  indexPath: string
  invocationId: string
  types?: string[]
  limit: number
  maxBytes: number
}): Promise<{ pages: Success[]; events: InvocationEventEnvelope[] }> {
  const pages: Success[] = []
  const events: InvocationEventEnvelope[] = []
  let afterSeq = 0
  for (let pageNumber = 0; pageNumber < 100; pageNumber += 1) {
    const run = await runReader({
      ledgerPath: input.ledgerPath,
      indexPath: input.indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: input.invocationId,
        afterSeq,
        ...(input.types === undefined ? {} : { types: input.types }),
        limit: input.limit,
        maxBytes: input.maxBytes,
      },
    })
    expect(run.exitCode).toBe(0)
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(input.maxBytes)
    const page = run.response as Success
    pages.push(page)
    events.push(...page.result.events)
    expect(page.nextAfterSeq).toBeGreaterThanOrEqual(afterSeq)
    if (!page.hasMore) return { pages, events }
    expect(page.nextAfterSeq).toBeGreaterThan(afterSeq)
    afterSeq = page.nextAfterSeq
  }
  throw new Error('offline reader failed to terminate paging within 100 pages')
}

describe('T-08565 offline normalized ledger reads', () => {
  test('a private DB+WAL snapshot sees an uncheckpointed committed floor and mutates no source file', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    for (let seq = 1; seq <= 5; seq += 1) await ledger.append(event('inv_wal', seq))
    await ledger.ackEvents('inv_wal' as InvocationId, 3)
    await ledger.prune({ activeInvocationIds: [] })
    writeFileSync(join(root, 'raw-input.ndjson'), '{"committed":true}\n')

    // Positive control: the writer remains open and the committed consumer
    // state is still represented by a live WAL/SHM pair when the reader starts.
    expect(existsSync(`${indexPath}-wal`)).toBe(true)
    expect(statSync(`${indexPath}-wal`).size).toBeGreaterThan(0)
    expect(existsSync(`${indexPath}-shm`)).toBe(true)
    const before = sourceHashes(root)

    const run = await runReader({
      ledgerPath,
      indexPath,
      request: { schema: SCHEMA, operation: 'eventsSince', invocationId: 'inv_wal', afterSeq: 3 },
    })

    expect(run.exitCode).toBe(0)
    expect(run.response).toMatchObject({
      ok: true,
      release: RELEASE,
      result: {
        events: [expect.objectContaining({ seq: 4 }), expect.objectContaining({ seq: 5 })],
        currentSeq: 5,
        retentionFloorSeq: 3,
      },
    })
    expect(sourceHashes(root)).toEqual(before)
    ledger.close()
  })

  test('count and byte bounded pages are complete, stable, and advance through filtered gaps', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    for (let seq = 1; seq <= 4; seq += 1) {
      await ledger.append(event('inv_filter', seq, 'diagnostic'))
    }
    await ledger.append(event('inv_filter', 5, 'turn.completed', { turnId: 'turn_1' }))
    for (let seq = 1; seq <= 6; seq += 1) {
      await ledger.append(
        event('inv_bytes', seq, 'diagnostic', {
          level: 'info',
          message: `${seq}:${'x'.repeat(24_000)}`,
        })
      )
    }
    ledger.close()

    const filtered = await readAllPages({
      ledgerPath,
      indexPath,
      invocationId: 'inv_filter',
      types: ['turn.completed'],
      limit: 2,
      maxBytes: 65_536,
    })
    expect(filtered.pages[0]).toMatchObject({
      result: { events: [], currentSeq: 5, retentionFloorSeq: 0 },
      hasMore: true,
      nextAfterSeq: 2,
    })
    expect(filtered.events.map((item) => item.seq)).toEqual([5])

    const bounded = await readAllPages({
      ledgerPath,
      indexPath,
      invocationId: 'inv_bytes',
      limit: 1000,
      maxBytes: 65_536,
    })
    expect(bounded.pages.length).toBeGreaterThan(1)
    expect(bounded.events.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5, 6])
    expect(bounded.pages.every((page) => page.result.currentSeq === 6)).toBe(true)
    expect(new Set(bounded.pages.map((page) => JSON.stringify(page.snapshot))).size).toBe(1)
  })

  test('one envelope larger than maxBytes is refused with no partial success', async () => {
    const root = scratch()
    const ledgerPath = join(root, 'events.ndjson')
    const indexPath = join(root, 'ledger-index.db')
    const ledger = createEventLedger({ path: ledgerPath, indexPath })
    await ledger.append(
      event('inv_oversize', 1, 'diagnostic', { level: 'info', message: 'x'.repeat(80_000) })
    )
    ledger.close()

    const run = await runReader({
      ledgerPath,
      indexPath,
      request: {
        schema: SCHEMA,
        operation: 'eventsSince',
        invocationId: 'inv_oversize',
        afterSeq: 0,
        maxBytes: 65_536,
      },
    })

    expect(run.exitCode).toBe(2)
    expect(run.response).toMatchObject({
      ok: false,
      operation: 'eventsSince',
      error: {
        code: 'offline_record_too_large',
        data: { kind: 'event', seq: 1, maxBytes: 65_536 },
      },
    })
    expect(run.response.result).toBeUndefined()
  })
})
