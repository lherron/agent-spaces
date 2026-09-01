import { describe, expect, test } from 'bun:test'
import type {
  CaptureReleaseNormalizedAs,
  CaptureReleasedPayload,
  CaptureStateView,
  EventFamily,
  EventProvenance,
  EventSourceKind,
  EvidenceAuthority,
  EvidenceAuthorityMatrix,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationEventEnvelope,
  InvocationEventType,
  RawProviderRecord,
  RawRecordDisposition,
  RawSourceCursor,
} from '../src/index'
import {
  CAPTURE_RELEASE_NOT_BLOCKED,
  EVENT_FAMILY_BY_TYPE,
  LOAD_BEARING_EVENT_FAMILIES,
  isLoadBearingEventFamily,
  validateEventEnvelope,
} from '../src/index'

const envelope = (extra: Record<string, unknown> = {}): unknown => ({
  invocationId: 'inv_1',
  seq: 1,
  time: '2026-09-01T12:00:00.000Z',
  type: 'invocation.ready',
  payload: { state: 'ready' },
  ...extra,
})

describe('EventProvenance on the envelope', () => {
  test('is OPTIONAL, so records committed before the capture contract still replay', () => {
    // This is the compatibility promise that made `provenance` optional rather
    // than required: the Phase 1a ledger already holds records without it and
    // replays them through this very validator.
    expect(() => validateEventEnvelope(envelope())).not.toThrow()
  })

  test('accepts a fully populated provenance', () => {
    const provenance: EventProvenance = {
      rawRecordId: 'raw_000001',
      sourceKind: 'provider-jsonl',
      sourceEpoch: 'ep_1',
      sourceCursor: { byteOffset: 42, line: 7 },
      nativeType: 'queue-operation',
      nativeId: 'op_1',
      rawSha256: 'a'.repeat(64),
      normalizer: { name: 'claude-code-tmux', version: '0.1.0' },
    }
    expect(() => validateEventEnvelope(envelope({ provenance }))).not.toThrow()
  })

  test('a PRESENT provenance must be actionable, not a half-filled bag', () => {
    // Missing sourceKind.
    expect(() =>
      validateEventEnvelope(envelope({ provenance: { normalizer: { name: 'x', version: '1' } } }))
    ).toThrow()
    // Missing normalizer identity.
    expect(() => validateEventEnvelope(envelope({ provenance: { sourceKind: 'hook' } }))).toThrow()
    // Unknown source kind.
    expect(() =>
      validateEventEnvelope(
        envelope({
          provenance: { sourceKind: 'telepathy', normalizer: { name: 'x', version: '1' } },
        })
      )
    ).toThrow()
    // Cursor values must be addressable scalars.
    expect(() =>
      validateEventEnvelope(
        envelope({
          provenance: {
            sourceKind: 'hook',
            sourceCursor: { byteOffset: { nested: true } },
            normalizer: { name: 'x', version: '1' },
          },
        })
      )
    ).toThrow()
  })

  test('all four source kinds are accepted', () => {
    const kinds: EventSourceKind[] = ['provider-jsonl', 'provider-jsonrpc', 'hook', 'broker']
    for (const sourceKind of kinds) {
      expect(() =>
        validateEventEnvelope(
          envelope({ provenance: { sourceKind, normalizer: { name: 'x', version: '1' } } })
        )
      ).not.toThrow()
    }
  })
})

describe('capture.released payload', () => {
  test('requires the released record, its disposition and the resumed count', () => {
    const payload: CaptureReleasedPayload = {
      rawRecordId: 'raw_000002',
      disposition: 'ignored-known',
      family: 'submission-disposition',
      nativeType: 'queue-operation:reprioritize',
      note: 'reviewed',
      resumedRecords: 2,
    }
    expect(() =>
      validateEventEnvelope(envelope({ type: 'capture.released', payload }))
    ).not.toThrow()
    expect(() =>
      validateEventEnvelope(
        envelope({ type: 'capture.released', payload: { rawRecordId: 'r', disposition: 'x' } })
      )
    ).toThrow()
  })

  test('an operator-authored normalizedAs names a real event type', () => {
    const good: CaptureReleasedPayload = {
      rawRecordId: 'raw_1',
      disposition: 'normalized',
      normalizedAs: { type: 'submission.cancelled' },
      resumedRecords: 0,
    }
    expect(() =>
      validateEventEnvelope(envelope({ type: 'capture.released', payload: good }))
    ).not.toThrow()
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'capture.released',
          payload: { ...good, normalizedAs: { type: 'not.an.event' } },
        })
      )
    ).toThrow()
  })
})

describe('event family taxonomy', () => {
  test('classifies every event type in the payload map', () => {
    const classified = Object.keys(EVENT_FAMILY_BY_TYPE) as InvocationEventType[]
    // The map is typed as a total Record, so an unclassified event fails the
    // build; this asserts the runtime object matches that promise.
    expect(classified.length).toBeGreaterThan(40)
    for (const type of classified) {
      expect(typeof EVENT_FAMILY_BY_TYPE[type]).toBe('string')
    }
  })

  test('load-bearing families are the ones a consumer acts on', () => {
    const families: EventFamily[] = [...LOAD_BEARING_EVENT_FAMILIES]
    expect(families).toContain('turn-bracket')
    expect(families).toContain('submission-disposition')
    expect(isLoadBearingEventFamily('conversation')).toBe(true)
    expect(isLoadBearingEventFamily('terminal-surface')).toBe(false)
  })
})

describe('capture types compile against their documented shapes', () => {
  test('the raw record, disposition, matrix and RPC shapes are usable as declared', () => {
    const cursor: RawSourceCursor = { byteOffset: 0, line: 1, nativeSequence: 'n1' }
    const record: RawProviderRecord = {
      rawRecordId: 'raw_1',
      invocationId: 'inv_1',
      provider: 'anthropic',
      driverKind: 'claude-code-tmux',
      sourceKind: 'provider-jsonl',
      sourceEpoch: 'ep_1',
      sourceCursor: cursor,
      nativeType: 'user',
      observedAt: '2026-09-01T12:00:00.000Z',
      sha256: 'a'.repeat(64),
      rawBytes: new Uint8Array([1, 2, 3]),
    }
    const dispositions: RawRecordDisposition[] = [
      'pending',
      'normalized',
      'state-only',
      'duplicate',
      'ignored-known',
      'blocked-unknown',
    ]
    const authority: EvidenceAuthority = 'native'
    const matrix: Partial<EvidenceAuthorityMatrix> = { conversation: authority }
    const state: CaptureStateView = { state: 'open', deferredCount: 0 }
    const normalizedAs: CaptureReleaseNormalizedAs = {
      type: 'submission.cancelled',
      payload: { submissionId: 's1' },
    }
    const request: InvocationCaptureReleaseRequest = {
      invocationId: 'inv_1',
      rawRecordId: 'raw_1',
      disposition: 'normalized-as',
      normalizedAs,
    }
    const response: InvocationCaptureReleaseResponse = {
      released: true,
      invocationId: 'inv_1',
      rawRecordId: 'raw_1',
      disposition: 'normalized',
      releasedSeq: 9,
      resumedRecords: 0,
      capture: state,
    }
    const replayed: InvocationEventEnvelope | undefined = undefined

    expect(record.rawBytes).toHaveLength(3)
    expect(dispositions).toHaveLength(6)
    expect(matrix.conversation).toBe('native')
    expect(request.normalizedAs?.type).toBe('submission.cancelled')
    expect(response.released).toBe(true)
    expect(replayed).toBeUndefined()
    expect(CAPTURE_RELEASE_NOT_BLOCKED).toBe('raw_record_not_blocked')
  })
})
