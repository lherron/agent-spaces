import type {
  EventProvenance,
  InputId,
  InvocationEvent,
  InvocationEventEnvelope,
  InvocationEventEnvelopeBase,
  InvocationEventEnvelopeFor,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { validateEventEnvelope } from 'spaces-harness-broker-protocol'

export interface EventSequencerOptions {
  now: () => Date
  correlation?: Record<string, string> | undefined
  /**
   * Durable resume point for an invocation this process has not sequenced yet.
   * The durable broker wires this to the event ledger so a restart continues
   * after the last COMMITTED seq instead of restarting at 1 and colliding with
   * records that survived the crash. Defaults to 0 (fresh stream).
   */
  resumeSeq?: ((invocationId: InvocationId) => number) | undefined
}

export interface InvocationEventExtra {
  turnId?: TurnId | undefined
  inputId?: InputId | undefined
  itemId?: string | undefined
  driver?: { kind: string; rawType?: string | undefined } | undefined
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
  provenance?: EventProvenance | undefined
}

export interface InvocationEventSequencer {
  next<K extends InvocationEventType>(
    invocationId: InvocationId,
    type: K,
    payload: InvocationEventPayloadMap[K],
    extra?: InvocationEventExtra
  ): InvocationEventEnvelopeFor<K>
  nextEvent(
    invocationId: InvocationId,
    event: InvocationEvent,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope
}

export function createInvocationEventSequencer(
  options: EventSequencerOptions
): InvocationEventSequencer {
  const counters = new Map<string, number>()
  const { now, correlation } = options
  const resumeSeq = options.resumeSeq ?? (() => 0)

  function currentSeq(invocationId: InvocationId): number {
    const known = counters.get(invocationId)
    return known !== undefined ? known : resumeSeq(invocationId)
  }

  function nextEvent(
    invocationId: InvocationId,
    event: InvocationEvent,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope {
    const current = currentSeq(invocationId)
    const seq = current + 1

    const envelopeMetadata: InvocationEventEnvelopeBase & { type: InvocationEventType } = {
      invocationId,
      seq,
      time: now().toISOString(),
      type: event.type,
    }
    applyExtra(envelopeMetadata, extra, correlation)
    const candidate: unknown = Object.assign(envelopeMetadata, { payload: event.payload })
    const validated = validateEventEnvelope(candidate)
    counters.set(invocationId, seq)
    return validated
  }

  return {
    next<K extends InvocationEventType>(
      invocationId: InvocationId,
      type: K,
      payload: InvocationEventPayloadMap[K],
      extra?: InvocationEventExtra
    ): InvocationEventEnvelopeFor<K> {
      const current = currentSeq(invocationId)
      const seq = current + 1
      const envelopeMetadata: InvocationEventEnvelopeBase & { type: K } = {
        invocationId,
        seq,
        time: now().toISOString(),
        type,
      }
      applyExtra(envelopeMetadata, extra, correlation)
      const candidate: InvocationEventEnvelopeFor<K> = Object.assign(envelopeMetadata, { payload })
      validateEventEnvelope(candidate)
      counters.set(invocationId, seq)
      return candidate
    },
    nextEvent,
  }
}

function applyExtra(
  envelope: InvocationEventEnvelopeBase,
  extra: InvocationEventExtra | undefined,
  correlation: Record<string, string> | undefined
): void {
  if (extra?.turnId !== undefined) envelope.turnId = extra.turnId
  if (extra?.inputId !== undefined) envelope.inputId = extra.inputId
  if (extra?.itemId !== undefined) envelope.itemId = extra.itemId
  if (extra?.driver !== undefined) envelope.driver = extra.driver
  if (extra?.harnessGeneration !== undefined) {
    envelope.harnessGeneration = extra.harnessGeneration
  }
  if (extra?.turnAttempt !== undefined) envelope.turnAttempt = extra.turnAttempt
  if (extra?.provenance !== undefined) envelope.provenance = extra.provenance
  if (correlation !== undefined) envelope.correlation = correlation
}
