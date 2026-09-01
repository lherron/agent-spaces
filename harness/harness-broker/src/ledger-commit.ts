import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'
import type { EventLedger } from './event-ledger'

/** Stable `reason` on the storage terminal and on every post-failure RPC error. */
export const LEDGER_APPEND_FAILED = 'ledger_append_failed'

export interface LedgerStorageFailure {
  invocationId: InvocationId
  /** Seq of the event whose commit failed — never published. */
  seq: number
  /** Type of the event whose commit failed. */
  type: string
  detail: string
}

export interface CommittedEventPublisherOptions {
  ledger: EventLedger
  /** Downstream fan-out (controller notify + observer socket). */
  publish: (event: InvocationEventEnvelope) => void
  /**
   * Called exactly once per invocation, synchronously, the first time a commit
   * fails. The broker wires this to the invocation manager so the invocation
   * transitions to a typed storage failure and its driver is stopped/disposed.
   */
  onStorageFailure: (failure: LedgerStorageFailure) => void
}

export interface CommittedEventPublisher {
  /**
   * Commit-before-publish. The event reaches controllers and observers ONLY
   * after its durable append returns; a failed append publishes nothing, for
   * this event or any later one on the same invocation.
   */
  commitAndPublish(event: InvocationEventEnvelope): void
  /** The recorded storage failure for an invocation, if it has one. */
  storageFailure(invocationId: InvocationId): LedgerStorageFailure | undefined
  /** Throw the typed post-failure error if this invocation's ledger is poisoned. */
  assertCommittable(invocationId: InvocationId): void
}

interface FailureRecord extends LedgerStorageFailure {
  /** The storage terminal gets exactly one commit attempt; never a retry loop. */
  terminalAttempted: boolean
}

export function createCommittedEventPublisher(
  options: CommittedEventPublisherOptions
): CommittedEventPublisher {
  const { ledger, publish, onStorageFailure } = options
  const failures = new Map<string, FailureRecord>()

  function isStorageTerminal(event: InvocationEventEnvelope): boolean {
    return (
      event.type === 'invocation.failed' &&
      (event.payload as { reason?: unknown }).reason === LEDGER_APPEND_FAILED
    )
  }

  return {
    commitAndPublish(event: InvocationEventEnvelope): void {
      const failure = failures.get(event.invocationId)
      if (failure !== undefined) {
        // Fail closed. The ONE event still allowed through is the typed storage
        // terminal itself — it is how a controller with no other channel learns
        // the stream ended. If even that cannot be committed, nothing is
        // published and the controller finds out from its next RPC instead.
        if (!isStorageTerminal(event) || failure.terminalAttempted) {
          return
        }
        failure.terminalAttempted = true
        try {
          ledger.appendSync(event)
        } catch {
          return
        }
        publish(event)
        return
      }

      try {
        ledger.appendSync(event)
      } catch (error) {
        const record: FailureRecord = {
          invocationId: event.invocationId,
          seq: event.seq,
          type: event.type,
          detail: error instanceof Error ? error.message : String(error),
          terminalAttempted: false,
        }
        // Recorded BEFORE the callback: the callback synchronously emits the
        // storage terminal, which re-enters this function and must see the
        // poisoned state it is reacting to.
        failures.set(event.invocationId, record)
        onStorageFailure({
          invocationId: record.invocationId,
          seq: record.seq,
          type: record.type,
          detail: record.detail,
        })
        return
      }

      publish(event)
    },

    storageFailure(invocationId: InvocationId): LedgerStorageFailure | undefined {
      return failures.get(invocationId)
    },

    assertCommittable(invocationId: InvocationId): void {
      const failure = failures.get(invocationId)
      if (failure === undefined) {
        return
      }
      throw new BrokerError(
        BrokerErrorCode.ResourceError,
        `Invocation ${invocationId} is not operable: event ledger append failed (${failure.detail})`,
        {
          reason: LEDGER_APPEND_FAILED,
          invocationId,
          failedSeq: failure.seq,
          failedType: failure.type,
          detail: failure.detail,
        }
      )
    },
  }
}
