import { describe, expect, test } from 'bun:test'
import type { CaptureReleasedPayload, EventProvenance, EventSourceKind } from '../src/index'
import { validateEventEnvelope } from '../src/index'
import { expectInvalidEventEnvelope, withValueAt, withoutKeyAt } from './schema-test-helpers'

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
    const released = envelope({ type: 'capture.released', payload })
    expect(() => validateEventEnvelope(released)).not.toThrow()
    // One fault per row, so each check is the only thing that can reject it.
    expectInvalidEventEnvelope(withoutKeyAt(released, ['payload', 'rawRecordId']), {
      path: 'payload.rawRecordId',
      code: 'required',
    })
    expectInvalidEventEnvelope(withValueAt(released, ['payload', 'disposition'], 'x'), {
      path: 'payload.disposition',
      code: 'invalid_literal',
    })
    expectInvalidEventEnvelope(withoutKeyAt(released, ['payload', 'resumedRecords']), {
      path: 'payload.resumedRecords',
      code: 'required',
    })
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

describe('disposition provenance may name any source; broker-only facts may not', () => {
  // Ruling on wrkq T-07863 (pointer on T-07860): provenance must be TRUE, so a
  // DISPOSITION accepts whichever source actually produced it, while a fact only
  // the broker can author must still say `broker`. Before the ruling,
  // `submission.absorbed` was broker-only, which forced claude-code-tmux to
  // overwrite the session-JSONL record it was minted from with a false one.
  const transcript: EventProvenance = {
    rawRecordId: 'raw_000045',
    sourceKind: 'provider-jsonl',
    sourceEpoch: 'ep_1',
    sourceCursor: { byteOffset: 10, line: 2 },
    nativeType: 'attachment:queued_command',
    rawSha256: 'a'.repeat(64),
    normalizer: { name: 'claude-code-tmux', version: '0.1.0' },
  }

  test('absorbed / executed / cancelled accept provider-observed provenance', () => {
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'submission.absorbed',
          provenance: transcript,
          payload: { submissionId: 's1', turnId: 'turn_live' },
        })
      )
    ).not.toThrow()
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'submission.executed',
          provenance: transcript,
          payload: { submissionId: 's1', turnId: 'turn_live' },
        })
      )
    ).not.toThrow()
    // `cancelled{reason:'recalled'}` IS the transcript popAll row.
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'submission.cancelled',
          provenance: transcript,
          payload: { submissionId: 's1', reason: 'recalled' },
        })
      )
    ).not.toThrow()
  })

  test('a disposition still REQUIRES provenance — any source, but not none', () => {
    expect(() =>
      validateEventEnvelope(
        envelope({ type: 'submission.absorbed', payload: { submissionId: 's1', turnId: 't' } })
      )
    ).toThrow()
  })

  test('a broker-only fact rejects provider-observed provenance', () => {
    // An admission refusal and a TTL expiry are broker decisions; no provider
    // reports them, so claiming one did is a falsehood the schema catches.
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'submission.rejected',
          provenance: transcript,
          payload: { submissionId: 's1', reason: 'busy_rejected' },
        })
      )
    ).toThrow()
    expect(() =>
      validateEventEnvelope(
        envelope({
          type: 'admission.admitted',
          provenance: transcript,
          payload: { submissionId: 's1', class: 'steer', origin: 'operator', layer: 'broker' },
        })
      )
    ).toThrow()
  })
})
