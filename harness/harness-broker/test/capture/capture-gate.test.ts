import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CaptureWarningPayload,
  EventFamily,
  EventProvenance,
  EventSourceKind,
  InvocationId,
  RawProviderRecord,
  RawRecordDisposition,
  RawSourceCursor,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../src/capture/capture-gate'
import { createCaptureGate } from '../../src/capture/capture-gate'
import { openCaptureIndex } from '../../src/capture/capture-index'
import { createRawJournal } from '../../src/capture/raw-journal'

const invocationId = 'inv_capture_1' as InvocationId
const roots: string[] = []

process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

interface Harness {
  dir: string
  gate: ReturnType<typeof createCaptureGate>
  warnings: CaptureWarningPayload[]
  /** Lines the gate wrote to the broker's own stderr. */
  logged: string[]
  index: ReturnType<typeof openCaptureIndex>
  dispositions: () => Record<string, RawRecordDisposition>
  close: () => void
}

function harness(options: { dir?: string } = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'capture-gate-'))
  if (options.dir === undefined) roots.push(dir)
  const warnings: CaptureWarningPayload[] = []
  const logged: string[] = []
  let seq = 0
  let epochCounter = 0
  const index = openCaptureIndex(join(dir, 'ledger-index.db'))
  const gate = createCaptureGate({
    invocationId,
    journal: createRawJournal({
      invocationId,
      dir,
      newEpochId: () => {
        epochCounter += 1
        return `ep_${epochCounter}`
      },
    }),
    index,
    normalizer: { name: 'test-driver', version: '9.9.9' },
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    emitWarning: (payload) => {
      warnings.push(payload)
      seq += 1
      return seq
    },
    warn: (line) => void logged.push(line),
  })
  return {
    dir,
    gate,
    warnings,
    logged,
    index,
    dispositions: () =>
      Object.fromEntries(index.list(invocationId).map((r) => [r.rawRecordId, r.disposition])),
    close: () => index.close(),
  }
}

/** Seed persisted state from a pre-T-07883 broker without a production writer. */
function seedLegacyCaptureBlock(dir: string): void {
  const db = new Database(join(dir, 'ledger-index.db'))
  try {
    db.query(
      `INSERT INTO capture_block
         (invocation_id, raw_record_id, native_type, family, message, since_iso)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      invocationId,
      'raw_000001',
      'queue-operation:hold',
      'tool',
      'unknown op',
      '2026-09-02T08:21:00.000Z'
    )
  } finally {
    db.close()
  }
}

function row(nativeType: string, body: unknown, cursor?: RawSourceCursor) {
  return {
    provider: 'anthropic',
    driverKind: 'test-driver',
    sourceKind: 'provider-jsonl' as EventSourceKind,
    sourceKey: 'transcript',
    nativeType,
    rawBytes: Buffer.from(JSON.stringify(body), 'utf8'),
    ...(cursor !== undefined ? { sourceCursor: cursor } : {}),
  }
}

const normalized = (): NormalizeOutcome => ({ disposition: 'normalized' })
const blocked = (family: EventFamily, message: string) => (): NormalizeOutcome => ({
  disposition: 'blocked-unknown',
  family,
  message,
})

describe('capture gate: raw commit precedes normalization', () => {
  test('a record is durable on disk BEFORE its normalizer runs', () => {
    const h = harness()
    let onDiskDuringNormalize = ''
    h.gate.ingest(row('user', { type: 'user' }), (captured: CapturedRecord) => {
      // Read the journal from INSIDE the normalizer: if the commit really came
      // first, the row is already there. A crash at this point must still leave
      // the evidence behind.
      onDiskDuringNormalize = readFileSync(join(h.dir, 'raw', `${invocationId}.ndjson`), 'utf8')
      expect(captured.record.sha256).toHaveLength(64)
      return normalized()
    })
    expect(onDiskDuringNormalize).toContain('raw_000001')
    expect(onDiskDuringNormalize).toContain('"nativeType":"user"')
    h.close()
  })

  test('a crash between raw commit and normalization re-normalizes to the same identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-crash-'))
    roots.push(dir)

    // Process 1: commit, then die mid-normalize.
    const first = harness({ dir })
    expect(() =>
      first.gate.ingest(row('queue-operation:enqueue', { operation: 'enqueue' }), () => {
        throw new Error('killed mid-normalize')
      })
    ).not.toThrow()
    // A normalizer that dies classified nothing — that is the "provider method
    // silently disappeared" case, so it is blocked-unknown, never lost.
    expect(Object.values(first.dispositions())).toEqual(['blocked-unknown'])
    first.close()

    // Process 2: a fresh gate over the SAME journal replays whatever never
    // reached a terminal disposition, minting the identical record identity.
    const second = harness({ dir })
    second.index.dispose(invocationId, 'raw_000001', 'pending')
    const seen: RawProviderRecord[] = []
    const replayed = second.gate.replayPending((captured) => {
      seen.push(captured.record)
      return normalized()
    })
    expect(replayed).toBe(1)
    expect(seen[0]?.rawRecordId).toBe('raw_000001')
    expect(seen[0]?.nativeType).toBe('queue-operation:enqueue')
    expect(second.dispositions()['raw_000001']).toBe('normalized')
    second.close()
  })
})

describe('capture gate: every record reaches exactly one disposition', () => {
  test('each terminal disposition is recorded durably', () => {
    const h = harness()
    const outcomes: NormalizeOutcome[] = [
      { disposition: 'normalized' },
      { disposition: 'state-only', detail: 'mirror state' },
      { disposition: 'duplicate', detail: 'owned by the hook path' },
      { disposition: 'ignored-known', detail: 'cost-state' },
    ]
    for (const [n, outcome] of outcomes.entries()) {
      h.gate.ingest(row(`row_${n}`, { n }), () => outcome)
    }
    h.gate.ingest(row('mystery', {}), blocked('usage', 'Unknown usage row'))

    expect(Object.values(h.dispositions())).toEqual([
      'normalized',
      'state-only',
      'duplicate',
      'ignored-known',
      'blocked-unknown',
    ])
    // Not load-bearing: warned, cursor NOT halted.
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]?.kind).toBe('blocked_unknown')
    expect((h.warnings[0]?.raw as { cursorHalted?: boolean }).cursorHalted).toBe(false)
    expect(h.gate.state().state).toBe('open')
    h.close()
  })

  test('provenance carries the record identity, cursor and normalizer version', () => {
    const h = harness()
    let provenance: EventProvenance | undefined
    h.gate.ingest(row('user', { type: 'user' }, { byteOffset: 42, line: 7 }), (captured) => {
      provenance = captured.provenance()
      return normalized()
    })
    expect(provenance).toMatchObject({
      rawRecordId: 'raw_000001',
      sourceKind: 'provider-jsonl',
      sourceCursor: { byteOffset: 42, line: 7 },
      nativeType: 'user',
      normalizer: { name: 'test-driver', version: '9.9.9' },
    })
    expect(provenance?.rawSha256).toHaveLength(64)
    h.close()
  })
})

describe('capture gate: a blocked-unknown NEVER halts the cursor (T-07883)', () => {
  test('the WARN line is ONE line even when the normalizer throws a multi-line error', () => {
    const h = harness()
    h.gate.ingest(row('exploding', {}), () => {
      throw new Error('Invalid invocation event envelope\n  at line 1\n  at line 2')
    })
    expect(h.logged).toHaveLength(1)
    expect(h.logged[0]).not.toContain('\n')
    expect(h.logged[0]).toContain('family=diagnostic')
    expect(h.logged[0]).toContain('Normalizer threw: Invalid invocation event envelope at line 1')
    h.close()
  })

  test('a halt persisted by a PRE-T-07883 broker is cleared on load, not resurrected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-legacy-halt-'))
    roots.push(dir)

    // A pre-ruling broker: a blocked-unknown wrote the block row, and the
    // records behind it were committed but left `pending`.
    const first = harness({ dir })
    first.gate.ingest(row('queue-operation:hold', {}), blocked('tool', 'unknown op'))
    first.gate.ingest(row('held', {}), normalized)
    first.index.dispose(invocationId, 'raw_000002', 'pending')
    first.close()
    seedLegacyCaptureBlock(dir)

    const second = harness({ dir })
    expect(second.gate.state()).toMatchObject({ state: 'open', deferredCount: 0 })
    expect(second.index.blockedOn(invocationId)).toBeUndefined()
    expect(second.logged[0]).toContain(
      'WARN harness-broker capture halt cleared (T-07883: the cursor no longer halts)'
    )
    expect(second.logged[0]).toContain('rawRecordId=raw_000001')

    // And the record it was holding normalizes through the ordinary replay.
    const replayed = second.gate.replayPending(normalized)
    expect(replayed).toBe(1)
    expect(second.dispositions()['raw_000002']).toBe('normalized')
    second.close()
  })
})
