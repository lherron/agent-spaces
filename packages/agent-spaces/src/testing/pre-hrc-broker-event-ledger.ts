import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import type { ContractHarnessFailure } from './pre-hrc-broker-contract-types.js'

const NORMALIZED_EVENT_TYPES = new Set<InvocationEventType>([
  'invocation.started',
  'invocation.ready',
  'invocation.stopping',
  'invocation.exited',
  'invocation.failed',
  'invocation.disposed',
  'continuation.updated',
  'input.accepted',
  'input.rejected',
  'input.queued',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
  'assistant.message.started',
  'assistant.message.delta',
  'assistant.message.completed',
  'tool.call.started',
  'tool.call.delta',
  'tool.call.completed',
  'tool.call.failed',
  'usage.updated',
  'diagnostic',
  'driver.notice',
  'permission.requested',
  'permission.resolved',
])

const TERMINAL_TURN_EVENT_TYPES = new Set<InvocationEventType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])

type DuplicateConflict = {
  invocationId: string
  seq: number
  existingHash: string
  incomingHash: string
}

function eventKey(event: InvocationEventEnvelope): string {
  return `${event.invocationId}:${event.seq}`
}

function eventHash(event: InvocationEventEnvelope): string {
  return createCanonicalHasher().hash(event, { timestampMode: 'include-semantic' }).value
}

export class PreHrcBrokerEventLedger {
  #events: InvocationEventEnvelope[] = []
  #byKey = new Map<string, { event: InvocationEventEnvelope; hash: string }>()
  #duplicateConflicts: DuplicateConflict[] = []

  append(event: InvocationEventEnvelope): void {
    const key = eventKey(event)
    const hash = eventHash(event)
    const existing = this.#byKey.get(key)
    if (existing !== undefined) {
      if (existing.hash !== hash) {
        this.#duplicateConflicts.push({
          invocationId: event.invocationId,
          seq: event.seq,
          existingHash: existing.hash,
          incomingHash: hash,
        })
      }
      return
    }

    this.#byKey.set(key, { event, hash })
    this.#events.push(event)
  }

  events(): InvocationEventEnvelope[] {
    return [...this.#events]
  }

  eventTypes(): InvocationEventType[] {
    return this.#events.map((event) => event.type)
  }

  terminalTurnEvent(): InvocationEventEnvelope | undefined {
    return this.#events.find((event) => TERMINAL_TURN_EVENT_TYPES.has(event.type))
  }

  requireMonotonicSeq(): ContractHarnessFailure[] {
    const lastSeqByInvocation = new Map<string, number>()
    const failures: ContractHarnessFailure[] = []
    for (const event of this.#events) {
      const previous = lastSeqByInvocation.get(event.invocationId) ?? 0
      if (event.seq !== previous + 1) {
        failures.push({
          code: 'broker_event_seq_non_monotonic',
          message: 'Broker event seq must increase by exactly one per invocation.',
          path: `brokerEvents.${event.invocationId}.${event.seq}`,
          redactedDetails: {
            invocationId: event.invocationId,
            previousSeq: previous,
            seq: event.seq,
            type: event.type,
          },
        })
      }
      lastSeqByInvocation.set(event.invocationId, Math.max(previous, event.seq))
    }
    return failures
  }

  requireNoDuplicates(): ContractHarnessFailure[] {
    return this.#duplicateConflicts.map((conflict) => ({
      code: 'broker_event_duplicate_conflict',
      message: 'Broker emitted the same invocationId + seq with different event JSON.',
      path: `brokerEvents.${conflict.invocationId}.${conflict.seq}`,
      redactedDetails: conflict,
    }))
  }

  requireOnlyNormalizedEventTypes(): ContractHarnessFailure[] {
    const failures: ContractHarnessFailure[] = []
    for (const event of this.#events) {
      if (!NORMALIZED_EVENT_TYPES.has(event.type)) {
        failures.push({
          code: 'broker_event_type_not_normalized',
          message:
            'Broker event type must be a normalized invocation event type; native driver names belong only in event.driver.rawType.',
          path: `brokerEvents.${event.invocationId}.${event.seq}.type`,
          redactedDetails: {
            invocationId: event.invocationId,
            seq: event.seq,
            type: event.type,
            driverRawType: event.driver?.rawType,
          },
        })
      }
    }
    return failures
  }
}
