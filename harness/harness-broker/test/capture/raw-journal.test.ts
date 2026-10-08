import { afterAll, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { InvocationId } from 'spaces-harness-broker-protocol'
import { createRawJournal } from '../../src/capture/raw-journal'

/**
 * T-10581 — the raw journal must stay bounded in memory and per-call work no
 * matter how large an invocation's evidence grows. A 2.5 GB journal (one long
 * Codex turn whose PostToolUse hooks carried ~1.4 MB each) wedged a live broker
 * at 100% CPU: every row was mirrored in memory, and every read slurped the
 * whole file into one string past the engine's maximum string length.
 */

const invocationId = 'inv_raw_journal' as InvocationId
const roots: string[] = []

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'raw-journal-'))
  roots.push(dir)
  return dir
}

function append(journal: ReturnType<typeof createRawJournal>, text: string, sourceKey = 's') {
  return journal.append({
    provider: 'openai',
    driverKind: 'codex-app-server',
    sourceKind: 'provider-jsonrpc',
    sourceKey,
    nativeType: 'item/completed',
    rawBytes: Buffer.from(text, 'utf8'),
  })
}

const text = (record: { rawBytes: Uint8Array }) => Buffer.from(record.rawBytes).toString('utf8')

describe('raw journal: streaming scan', () => {
  test('scan visits every record in commit order and resumes from its cursor', () => {
    const journal = createRawJournal({ invocationId, dir: scratch() })
    append(journal, 'one')
    append(journal, 'two')

    const first: string[] = []
    const cursor = journal.scan((record) => void first.push(text(record)))
    expect(first).toEqual(['one', 'two'])

    append(journal, 'three')
    const rest: string[] = []
    const next = journal.scan((record) => void rest.push(text(record)), cursor)
    expect(rest).toEqual(['three'])

    const none: string[] = []
    expect(journal.scan((record) => void none.push(text(record)), next)).toBe(next)
    expect(none).toEqual([])
  })

  test('rows larger than the read chunk survive intact', () => {
    const big = 'x'.repeat(3 * 1024 * 1024 + 17)
    const journal = createRawJournal({ invocationId, dir: scratch(), readChunkBytes: 64 * 1024 })
    append(journal, 'small')
    append(journal, big)
    append(journal, 'tail')
    const seen: string[] = []
    journal.scan((record) => void seen.push(text(record)))
    expect(seen.map((value) => value.length)).toEqual([5, big.length, 4])
    expect(seen[1]).toBe(big)
  })

  test('an in-memory journal scans and resumes the same way', () => {
    const journal = createRawJournal({ invocationId })
    append(journal, 'a')
    const cursor = journal.scan(() => {})
    append(journal, 'b')
    const seen: string[] = []
    journal.scan((record) => void seen.push(text(record)), cursor)
    expect(seen).toEqual(['b'])
    expect(journal.read().map(text)).toEqual(['a', 'b'])
  })
})

describe('raw journal: restart', () => {
  test('a reopened journal continues the ordinal and inherits each source epoch', () => {
    const dir = scratch()
    let epoch = 0
    const newEpochId = () => `ep_${++epoch}`
    const first = createRawJournal({ invocationId, dir, newEpochId })
    append(first, 'a', 'left')
    append(first, 'b', 'right')

    const reopened = createRawJournal({ invocationId, dir, newEpochId })
    const next = append(reopened, 'c', 'left')
    expect(next.rawRecordId).toBe('raw_000003')
    expect(next.sourceEpoch).toBe('ep_1')
    expect(reopened.read().map(text)).toEqual(['a', 'b', 'c'])
  })

  test('a torn final line stays as residue and does not swallow the next record', () => {
    const dir = scratch()
    const first = createRawJournal({ invocationId, dir })
    append(first, 'kept')
    const path = first.path as string
    appendFileSync(path, '{"rawRecordId":"raw_000002","rawBase64":"dG9y')

    const reopened = createRawJournal({ invocationId, dir })
    append(reopened, 'after')
    expect(reopened.read().map(text)).toEqual(['kept', 'after'])
    expect(readFileSync(path, 'utf8')).toContain('"rawBase64":"dG9y\n')
  })

  test('an unreadable journal fails loudly instead of restarting the ordinal at zero', () => {
    const dir = scratch()
    // A directory where the journal file belongs: reading it is EISDIR.
    mkdirSync(join(dir, 'raw', `${invocationId}.ndjson`), { recursive: true })
    expect(() => createRawJournal({ invocationId, dir })).toThrow()
  })
})
