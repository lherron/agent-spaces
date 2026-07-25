import type {
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
}

export interface InvocationEventExtra {
  turnId?: TurnId | undefined
  inputId?: InputId | undefined
  itemId?: string | undefined
  driver?: { kind: string; rawType?: string | undefined } | undefined
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
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

  function nextEvent(
    invocationId: InvocationId,
    event: InvocationEvent,
    extra?: InvocationEventExtra
  ): InvocationEventEnvelope {
    const current = counters.get(invocationId) ?? 0
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
      const current = counters.get(invocationId) ?? 0
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
  if (correlation !== undefined) envelope.correlation = correlation
}
