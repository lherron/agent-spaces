import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  CaptureReleasedPayload,
  CaptureStateView,
  CaptureWarningPayload,
  EventFamily,
  EventProvenance,
  EventSourceKind,
  InvocationId,
  RawProviderRecord,
  RawRecordDisposition,
  RawSourceCursor,
} from 'spaces-harness-broker-protocol'
import {
  EVENT_FAMILY_BY_TYPE,
  LOAD_BEARING_EVENT_FAMILIES,
  isLoadBearingEventFamily,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../src/capture/capture-gate'
import { CaptureRecordNotBlockedError, createCaptureGate } from '../../src/capture/capture-gate'
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
  released: CaptureReleasedPayload[]
  minted: Array<{ type: string; provenance: EventProvenance }>
  index: ReturnType<typeof openCaptureIndex>
  dispositions: () => Record<string, RawRecordDisposition>
  close: () => void
}

function harness(options: { dir?: string } = {}): Harness {
  const dir = options.dir ?? mkdtempSync(join(tmpdir(), 'capture-gate-'))
  if (options.dir === undefined) roots.push(dir)
  const warnings: CaptureWarningPayload[] = []
  const released: CaptureReleasedPayload[] = []
  const minted: Array<{ type: string; provenance: EventProvenance }> = []
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
    emitReleased: (payload) => {
      released.push(payload)
      seq += 1
      return seq
    },
    emitNormalizedAs: (spec, provenance) => {
      minted.push({ type: spec.type, provenance })
      seq += 1
      return seq
    },
  })
  return {
    dir,
    gate,
    warnings,
    released,
    minted,
    index,
    dispositions: () =>
      Object.fromEntries(index.list(invocationId).map((r) => [r.rawRecordId, r.disposition])),
    close: () => index.close(),
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

  test('a new source epoch changes the epoch id without skipping or duplicating rows', () => {
    const h = harness()
    h.gate.ingest(row('a', { n: 1 }, { byteOffset: 0, line: 1 }), normalized)
    // Truncation/replacement: the same byte offset now addresses a DIFFERENT
    // file, so it must not be compared against the pre-truncation cursor.
    h.gate.rotateEpoch('transcript')
    h.gate.ingest(row('b', { n: 2 }, { byteOffset: 0, line: 1 }), normalized)

    const epochs = h.index.list(invocationId).map((r) => r.sourceEpoch)
    expect(epochs[0]).not.toBe(epochs[1])
    expect(Object.values(h.dispositions())).toEqual(['normalized', 'normalized'])
    h.close()
  })
})

describe('capture gate: blocked-unknown halts the cursor until an operator releases it', () => {
  test('a load-bearing unknown stops normalization; later records commit but are held', () => {
    const h = harness()
    const normalizedTypes: string[] = []
    const record = (nativeType: string) =>
      h.gate.ingest(row(nativeType, { nativeType }), () => {
        normalizedTypes.push(nativeType)
        return normalized()
      })

    record('before')
    h.gate.ingest(
      row('queue-operation:reprioritize', { operation: 'reprioritize' }),
      blocked('submission-disposition', 'Unknown Claude queue operation: reprioritize')
    )
    record('after_1')
    record('after_2')

    expect(normalizedTypes).toEqual(['before'])
    expect(h.warnings.map((w) => w.kind)).toEqual(['blocked_unknown'])
    expect((h.warnings[0]?.raw as { cursorHalted?: boolean }).cursorHalted).toBe(true)

    const state: CaptureStateView = h.gate.state()
    expect(state.state).toBe('blocked')
    expect(state.deferredCount).toBe(2)
    expect(state.blockedOn).toMatchObject({
      rawRecordId: 'raw_000002',
      nativeType: 'queue-operation:reprioritize',
      family: 'submission-disposition',
    })
    // Evidence is NEVER dropped: held rows are committed and still pending.
    expect(h.dispositions()).toEqual({
      raw_000001: 'normalized',
      raw_000002: 'blocked-unknown',
      raw_000003: 'pending',
      raw_000004: 'pending',
    })

    const outcome = h.gate.release({
      rawRecordId: 'raw_000002',
      disposition: 'ignored-known',
      note: 'reviewed: cosmetic reorder',
    })
    expect(outcome.disposition).toBe('ignored-known')
    expect(outcome.resumedRecords).toBe(2)
    expect(outcome.capture.state).toBe('open')
    expect(normalizedTypes).toEqual(['before', 'after_1', 'after_2'])
    expect(h.released[0]).toMatchObject({
      rawRecordId: 'raw_000002',
      disposition: 'ignored-known',
      family: 'submission-disposition',
      note: 'reviewed: cosmetic reorder',
      resumedRecords: 2,
    })
    expect(h.dispositions()['raw_000002']).toBe('ignored-known')
    h.close()
  })

  test('a normalized-as release mints the operator-authored event with broker provenance', () => {
    const h = harness()
    h.gate.ingest(row('queue-operation:hold', {}), blocked('submission-disposition', 'unknown op'))
    const outcome = h.gate.release({
      rawRecordId: 'raw_000001',
      disposition: 'normalized-as',
      normalizedAs: { type: 'submission.cancelled', payload: { submissionId: 's1' } },
    })
    expect(outcome.disposition).toBe('normalized')
    expect(h.minted[0]?.type).toBe('submission.cancelled')
    // The classification decision was the OPERATOR's, so the minted event is
    // broker-authored — while still pointing at the raw bytes it came from.
    expect(h.minted[0]?.provenance).toMatchObject({
      sourceKind: 'broker',
      rawRecordId: 'raw_000001',
    })
    expect(h.dispositions()['raw_000001']).toBe('normalized')
    h.close()
  })

  test('releasing a record that is not the blocking one is refused', () => {
    const h = harness()
    h.gate.ingest(row('queue-operation:hold', {}), blocked('turn-bracket', 'unknown op'))
    expect(() =>
      h.gate.release({ rawRecordId: 'raw_999999', disposition: 'ignored-known' })
    ).toThrow(CaptureRecordNotBlockedError)
    expect(h.gate.state().state).toBe('blocked')
    h.close()
  })

  test('a second block inside the resumed drain halts again and holds the remainder', () => {
    const h = harness()
    h.gate.ingest(row('first', {}), blocked('conversation', 'unknown 1'))
    h.gate.ingest(row('second', {}), blocked('conversation', 'unknown 2'))
    h.gate.ingest(row('third', {}), normalized)

    const outcome = h.gate.release({ rawRecordId: 'raw_000001', disposition: 'ignored-known' })
    // The drain normalized the second record, which blocked again — so the
    // third stays held rather than slipping past an unresolved gap.
    expect(outcome.resumedRecords).toBe(1)
    expect(outcome.capture.state).toBe('blocked')
    expect(outcome.capture.blockedOn?.rawRecordId).toBe('raw_000002')
    expect(h.dispositions()['raw_000003']).toBe('pending')
    h.close()
  })

  test('the halt survives reopening the index: a restart does not quietly resume', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-halt-'))
    roots.push(dir)
    const first = harness({ dir })
    first.gate.ingest(row('queue-operation:hold', {}), blocked('tool', 'unknown op'))
    expect(first.gate.state().state).toBe('blocked')
    first.close()

    const second = harness({ dir })
    expect(second.gate.state().state).toBe('blocked')
    expect(second.gate.state().blockedOn?.rawRecordId).toBe('raw_000001')
    second.close()
  })
})

describe('event family taxonomy', () => {
  test('the load-bearing set is exactly the families a consumer acts on', () => {
    expect([...LOAD_BEARING_EVENT_FAMILIES].sort()).toEqual([
      'conversation',
      'input-admission',
      'permission',
      'submission-disposition',
      'tool',
      'turn-bracket',
    ])
    expect(isLoadBearingEventFamily('turn-bracket')).toBe(true)
    // Broker-decided supervision is NOT load-bearing: no provider reports
    // `turn.stalled`/`turn.retry`, so it can never carry an unclassified
    // provider type.
    expect(isLoadBearingEventFamily('turn-supervision')).toBe(false)
    expect(isLoadBearingEventFamily('diagnostic')).toBe(false)
  })

  test('input admission and submission disposition are separate families', () => {
    // They were one family in the first draft. They cannot be: admission is a
    // BROKER decision and submission outcomes are PROVIDER-observed, so a single
    // family would force one of the two authorities to be declared falsely.
    expect(EVENT_FAMILY_BY_TYPE['input.accepted']).toBe('input-admission')
    expect(EVENT_FAMILY_BY_TYPE['submission.absorbed']).toBe('submission-disposition')
    expect(EVENT_FAMILY_BY_TYPE['turn.started']).toBe('turn-bracket')
    expect(EVENT_FAMILY_BY_TYPE['turn.stalled']).toBe('turn-supervision')
  })
})
