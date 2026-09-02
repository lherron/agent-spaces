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
  /** Lines the gate wrote to the broker's own stderr. */
  logged: string[]
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
  const logged: string[] = []
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
    warn: (line) => void logged.push(line),
  })
  return {
    dir,
    gate,
    warnings,
    logged,
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

describe('capture gate: a blocked-unknown NEVER halts the cursor (T-07883)', () => {
  // Lance, 2026-09-02: "We should never halt when an unknown event arrives.
  // Harnesses are upgraded all the time; we don't want to hard-fail our entire
  // fleet when we haven't handled an upgraded new event. It should warn
  // loudly." These are the assertions that make that a behaviour, not a note.
  for (const family of LOAD_BEARING_EVENT_FAMILIES) {
    test(`a blocked-unknown in ${family} warns, logs at WARN, and the cursor advances`, () => {
      const h = harness()
      const normalizedTypes: string[] = []
      const record = (nativeType: string) =>
        h.gate.ingest(row(nativeType, { nativeType }), () => {
          normalizedTypes.push(nativeType)
          return normalized()
        })

      record('before')
      h.gate.ingest(row('mystery-native-type', { n: 1 }), blocked(family, `unknown ${family} row`))
      record('after_1')
      record('after_2')

      // The cursor ran straight through: nothing was held.
      expect(normalizedTypes).toEqual(['before', 'after_1', 'after_2'])
      expect(h.dispositions()).toEqual({
        raw_000001: 'normalized',
        raw_000002: 'blocked-unknown',
        raw_000003: 'normalized',
        raw_000004: 'normalized',
      })

      // Evidence is still committed, and the warning still carries the detail.
      expect(h.warnings).toHaveLength(1)
      expect(h.warnings[0]?.kind).toBe('blocked_unknown')
      expect(h.warnings[0]?.raw).toMatchObject({
        rawRecordId: 'raw_000002',
        nativeType: 'mystery-native-type',
        family,
        cursorHalted: false,
        loadBearing: true,
      })

      // ONE line on the broker's own log, readable without parsing ndjson.
      expect(h.logged).toHaveLength(1)
      expect(h.logged[0]).toBe(
        `WARN harness-broker capture blocked_unknown invocationId=${invocationId} ` +
          `driver=test-driver family=${family} nativeType=mystery-native-type ` +
          `rawRecordId=raw_000002 loadBearing=true message=unknown ${family} row`
      )

      const state: CaptureStateView = h.gate.state()
      expect(state.state).toBe('open')
      expect(state.deferredCount).toBe(0)
      expect(state.blockedOn).toBeUndefined()
      h.close()
    })
  }

  test('a repeated unknown type logs ONCE per (driver, nativeType, family), with a count', () => {
    const h = harness()
    for (let n = 0; n < 5; n += 1) {
      h.gate.ingest(row('mystery', { n }), blocked('conversation', 'Unknown Claude row: mystery'))
    }
    // A different family on the same type is a different key: a driver that
    // reclassifies drift must not be silenced by the first key it hit.
    h.gate.ingest(row('mystery', {}), blocked('diagnostic', 'Unknown Claude row: mystery'))
    h.gate.ingest(row('other', {}), blocked('conversation', 'Unknown Claude row: other'))

    // Every record still warns on the STREAM — the rate limit is on the log.
    expect(h.warnings).toHaveLength(7)
    expect(h.logged).toHaveLength(3)
    expect(h.gate.state().blockedUnknown).toEqual([
      {
        driver: 'test-driver',
        nativeType: 'mystery',
        family: 'conversation',
        loadBearing: true,
        count: 5,
        message: 'Unknown Claude row: mystery',
        firstSeenIso: '2026-09-01T12:00:00.000Z',
        lastSeenIso: '2026-09-01T12:00:00.000Z',
      },
      {
        driver: 'test-driver',
        nativeType: 'mystery',
        family: 'diagnostic',
        loadBearing: false,
        count: 1,
        message: 'Unknown Claude row: mystery',
        firstSeenIso: '2026-09-01T12:00:00.000Z',
        lastSeenIso: '2026-09-01T12:00:00.000Z',
      },
      {
        driver: 'test-driver',
        nativeType: 'other',
        family: 'conversation',
        loadBearing: true,
        count: 1,
        message: 'Unknown Claude row: other',
        firstSeenIso: '2026-09-01T12:00:00.000Z',
        lastSeenIso: '2026-09-01T12:00:00.000Z',
      },
    ])
    h.close()
  })

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

  test('release is refused: nothing is ever the blocked-unknown record', () => {
    const h = harness()
    h.gate.ingest(row('queue-operation:hold', {}), blocked('turn-bracket', 'unknown op'))
    // The RPC, the CLI and the SDK types stay on the wire (T-07883 item 5); the
    // gate answers with the existing typed refusal, and capture stays open.
    expect(() =>
      h.gate.release({ rawRecordId: 'raw_000001', disposition: 'ignored-known' })
    ).toThrow(CaptureRecordNotBlockedError)
    expect(h.released).toEqual([])
    expect(h.gate.state().state).toBe('open')
    h.close()
  })

  test('a halt persisted by a PRE-T-07883 broker is cleared on load, not resurrected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'capture-legacy-halt-'))
    roots.push(dir)

    // A pre-ruling broker: a blocked-unknown wrote the block row, and the
    // records behind it were committed but left `pending`.
    const first = harness({ dir })
    first.gate.ingest(row('queue-operation:hold', {}), blocked('tool', 'unknown op'))
    first.index.block({
      invocationId,
      rawRecordId: 'raw_000001',
      nativeType: 'queue-operation:hold',
      family: 'tool',
      message: 'unknown op',
      sinceIso: '2026-09-02T08:21:00.000Z',
    })
    first.gate.ingest(row('held', {}), normalized)
    first.index.dispose(invocationId, 'raw_000002', 'pending')
    first.close()

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

describe('event family taxonomy', () => {
  // Since T-07883 the taxonomy decides how LOUD a blocked-unknown is, never
  // whether capture stops — the load-bearing regressions above are what pin
  // that. It still has to be the right set: it is what a reader of
  // `capture.warning.raw.loadBearing` acts on.
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
