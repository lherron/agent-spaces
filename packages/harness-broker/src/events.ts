import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

export interface EventSequencerOptions {
  now: () => Date
  correlation?: Record<string, string> | undefined
}

export interface InvocationEventSequencer {
  next<TPayload>(
    invocationId: string,
    type: InvocationEventType,
    payload: TPayload,
    extra?: {
      turnId?: string | undefined
      inputId?: string | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
    }
  ): InvocationEventEnvelope<TPayload>
}

export function createInvocationEventSequencer(
  options: EventSequencerOptions
): InvocationEventSequencer {
  const counters = new Map<string, number>()
  const { now, correlation } = options

  return {
    next<TPayload>(
      invocationId: string,
      type: InvocationEventType,
      payload: TPayload,
      extra?: {
        turnId?: string | undefined
        inputId?: string | undefined
        itemId?: string | undefined
        driver?: { kind: string; rawType?: string | undefined } | undefined
      }
    ): InvocationEventEnvelope<TPayload> {
      const current = counters.get(invocationId) ?? 0
      const seq = current + 1
      counters.set(invocationId, seq)

      const envelope: InvocationEventEnvelope<TPayload> = {
        invocationId,
        seq,
        time: now().toISOString(),
        type,
        payload,
      }

      if (extra?.turnId !== undefined) {
        envelope.turnId = extra.turnId
      }
      if (extra?.inputId !== undefined) {
        envelope.inputId = extra.inputId
      }
      if (extra?.itemId !== undefined) {
        envelope.itemId = extra.itemId
      }
      if (extra?.driver !== undefined) {
        envelope.driver = extra.driver
      }
      if (correlation !== undefined) {
        envelope.correlation = correlation
      }

      return envelope
    },
  }
}
