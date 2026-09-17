import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
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
  tempRoot?: string
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
    {
      cwd: REPO_ROOT,
      env: { ...process.env, ...(input.tempRoot === undefined ? {} : { TMPDIR: input.tempRoot }) },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }
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
    expect(page.result.events.length).toBeLessThanOrEqual(input.limit)
    expect(page.nextAfterSeq).toBeGreaterThanOrEqual(afterSeq)
    if (!page.hasMore) return { pages, events }
    expect(page.nextAfterSeq).toBeGreaterThan(afterSeq)
    afterSeq = page.nextAfterSeq
  }
  throw new Error('offline reader failed to terminate paging within 100 pages')
}

describe('T-08565 offline normalized ledger reads', () => {
  test('a private DB+WAL snapshot sees a killed writer uncheckpointed floor and mutates no source file', async () => {
    const root = scratch()
    const source = join(root, 'source')
    mkdirSync(source)
    const ledgerPath = join(source, 'events.ndjson')
    const indexPath = join(source, 'ledger-index.db')
    const readyPath = join(root, 'writer.ready')
    const writerPath = join(root, 'killed-writer.mjs')
    const eventLedgerUrl = pathToFileURL(
      join(REPO_ROOT, 'harness/harness-broker/src/event-ledger.ts')
    ).href
    writeFileSync(
      writerPath,
      `import { writeFileSync } from 'node:fs'
import { createEventLedger } from ${JSON.stringify(eventLedgerUrl)}
const ledger = createEventLedger({ path: ${JSON.stringify(ledgerPath)}, indexPath: ${JSON.stringify(indexPath)} })
for (let seq = 1; seq <= 5; seq += 1) {
  await ledger.append({ invocationId: 'inv_wal', seq, time: new Date(seq * 1000).toISOString(), type: 'diagnostic', payload: { level: 'info', message: \`event-\${seq}\` } })
}
await ledger.ackEvents('inv_wal', 3)
await ledger.prune({ activeInvocationIds: [] })
writeFileSync(${JSON.stringify(join(source, 'raw-input.ndjson'))}, '{"committed":true}\\n')
writeFileSync(${JSON.stringify(readyPath)}, 'ready\\n')
await new Promise(() => {})
`
    )
    const writer = Bun.spawn(['bun', writerPath], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    let writerKilled = false
    try {
      for (let attempt = 0; attempt < 500 && !existsSync(readyPath); attempt += 1) {
        if (writer.exitCode !== null) break
        await Bun.sleep(10)
      }
      expect(existsSync(readyPath)).toBe(true)
      writer.kill('SIGKILL')
      await writer.exited
      writerKilled = true
    } finally {
      if (!writerKilled) {
        writer.kill('SIGKILL')
        await writer.exited
      }
    }

    // Positive control: the writer died without close/checkpoint and left the
    // committed floor in WAL. Controls open private copies only, never source.
    expect(existsSync(`${indexPath}-wal`)).toBe(true)
    expect(statSync(`${indexPath}-wal`).size).toBeGreaterThan(0)
    expect(existsSync(`${indexPath}-shm`)).toBe(true)
    const before = sourceHashes(source)

    const dbOnly = join(root, 'db-only')
    const dbAndWal = join(root, 'db-and-wal')
    mkdirSync(dbOnly)
    mkdirSync(dbAndWal)
    copyFileSync(indexPath, join(dbOnly, 'ledger-index.db'))
    copyFileSync(indexPath, join(dbAndWal, 'ledger-index.db'))
    copyFileSync(`${indexPath}-wal`, join(dbAndWal, 'ledger-index.db-wal'))

    const copiedFloor = (path: string): number | undefined => {
      const db = new Database(path)
      try {
        return db
          .query<{ retention_floor_seq: number }, []>(
            `SELECT retention_floor_seq FROM consumer_state WHERE invocation_id = 'inv_wal'`
          )
          .get()?.retention_floor_seq
      } catch {
        return undefined
      } finally {
        db.close()
      }
    }
    expect(copiedFloor(join(dbOnly, 'ledger-index.db'))).not.toBe(3)
    expect(copiedFloor(join(dbAndWal, 'ledger-index.db'))).toBe(3)

    const readerTemp = join(root, 'reader-temp')
    mkdirSync(readerTemp)

    const run = await runReader({
      ledgerPath,
      indexPath,
      tempRoot: readerTemp,
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
    expect(sourceHashes(source)).toEqual(before)
    expect(readdirSync(readerTemp)).toEqual([])
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
    expect(filtered.events.map((item) => item.seq)).toEqual([5])
    expect(
      filtered.pages.every(
        (page) => page.result.currentSeq === 5 && page.result.retentionFloorSeq === 0
      )
    ).toBe(true)

    const allExcluded = await readAllPages({
      ledgerPath,
      indexPath,
      invocationId: 'inv_filter',
      types: ['tool.call.started'],
      limit: 2,
      maxBytes: 65_536,
    })
    expect(allExcluded.events).toEqual([])
    expect(allExcluded.pages.at(-1)).toMatchObject({
      result: { currentSeq: 5, retentionFloorSeq: 0 },
      hasMore: false,
      nextAfterSeq: 5,
    })

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
