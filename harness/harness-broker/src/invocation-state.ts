import type {
  BrokerTerminalSurfaceReport,
  ContinuationUpdate,
  InputId,
  InvocationEventEnvelope,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { InvocationAdmission } from './invocation-admission'
import { REASON_INVOCATION_STOPPING, REASON_INVOCATION_TERMINATED } from './invocation-constants'
import type { EmitFn, Invocation } from './invocation-model'

export interface InvocationStateProjectionDeps {
  emit: EmitFn
  observePendingOwnTurnStart(inv: Invocation, turnId: TurnId, inputId?: InputId): void
  admission: InvocationAdmission
}

/** Project each sequenced event onto the manager-owned invocation record. */
export function createStateProjection(deps: InvocationStateProjectionDeps) {
  const { emit, observePendingOwnTurnStart } = deps
  const { maybeRequestPreemptInterrupt, scheduleDrain, scheduleAdmissionDrain, evictQueue } =
    deps.admission

  // ---------------------------------------------------------------------------
  // Event state machine
  // ---------------------------------------------------------------------------
  function applyEventState(inv: Invocation, event: InvocationEventEnvelope): void {
    // Inspection timestamps/seq project on EVERY event (T-01851): startedAt is
    // the first event's time, lastActivityAt/currentSeq track the latest.
    if (inv.startedAt === undefined) {
      inv.startedAt = event.time
    }
    inv.lastActivityAt = event.time
    inv.currentSeq = event.seq

    switch (event.type) {
      case 'invocation.started': {
        // Capture the child pid for the manager-owned status projection.
        const pid = (event.payload as { pid?: unknown } | undefined)?.pid
        if (typeof pid === 'number') {
          inv.childPid = pid
        }
        return
      }
      case 'harness.started': {
        // A real driver-owned harness.started supersedes the broker's synthetic
        // invocation.started fallback and carries generation + child pid.
        inv.harnessStartedSeen = true
        const payload = event.payload as { generation?: unknown; pid?: unknown } | undefined
        if (typeof payload?.generation === 'number') {
          inv.currentHarnessGeneration = payload.generation
        }
        if (typeof payload?.pid === 'number') {
          inv.childPid = payload.pid
        }
        return
      }
      case 'harness.recovery.completed': {
        const payload = event.payload as { toGeneration?: unknown } | undefined
        if (typeof payload?.toGeneration === 'number') {
          inv.currentHarnessGeneration = payload.toGeneration
        }
        return
      }
      case 'turn.retry': {
        const payload = event.payload as
          | { toAttempt?: unknown; toHarnessGeneration?: unknown }
          | undefined
        const toAttempt = event.turnAttempt ?? payload?.toAttempt
        if (typeof toAttempt === 'number') {
          inv.currentTurnAttempt = toAttempt
        }
        const toGeneration = event.harnessGeneration ?? payload?.toHarnessGeneration
        if (typeof toGeneration === 'number') {
          inv.currentHarnessGeneration = toGeneration
        }
        return
      }
      case 'terminal.surface.reported': {
        inv.terminalSurface = event.payload as BrokerTerminalSurfaceReport
        return
      }
      case 'invocation.ready':
        if (inv.state !== 'turn_active') inv.state = 'ready'
        return
      case 'input.accepted':
        if (
          (event.payload as { disposition?: unknown } | undefined)?.disposition ===
          'attempted_steer'
        ) {
          return
        }
        // The input that drives the next turn — cleared when the turn ends.
        if (event.inputId !== undefined && inv.driver.bracketMintingMode !== 'observed') {
          inv.currentInputId = event.inputId
        }
        return
      case 'turn.started': {
        inv.state = 'turn_active'
        if (event.turnId !== undefined) {
          inv.currentTurnId = event.turnId
        }
        const source = (event.payload as { source?: unknown } | undefined)?.source
        if (source === 'observed' && event.turnId !== undefined) {
          inv.unattributedTurnId = event.turnId
        }
        inv.currentTurnRequestInFlight = false
        // Project the active-turn summary fields (event fields first, then
        // payload, then manager-tracked fallbacks).
        const payload = event.payload as
          | { turnId?: unknown; inputId?: unknown; turnAttempt?: unknown }
          | undefined
        inv.currentTurnStartedAt = event.time
        const attempt = event.turnAttempt ?? payload?.turnAttempt
        inv.currentTurnAttempt = typeof attempt === 'number' ? attempt : 1
        const generation = event.harnessGeneration
        if (typeof generation === 'number') {
          inv.currentHarnessGeneration = generation
        }
        if (inv.driver.bracketMintingMode === 'harness-evidence' && event.inputId !== undefined) {
          const record = inv.submissions.get(event.inputId)
          if (record !== undefined && !record.terminal && event.turnId !== undefined) {
            emit(
              inv,
              'submission.executed',
              { submissionId: record.submissionId, turnId: event.turnId },
              { turnId: event.turnId, inputId: event.inputId }
            )
          }
        }
        return
      }
      case 'turn.attributed': {
        const payload = event.payload
        const turnId = event.turnId ?? payload.turnId
        if (inv.unattributedTurnId === turnId) inv.unattributedTurnId = undefined
        if (payload.ownership === 'own' && payload.inputId !== undefined) {
          inv.currentInputId = payload.inputId
          observePendingOwnTurnStart(inv, turnId, payload.inputId)
          const record = inv.submissions.get(payload.inputId)
          if (
            inv.driver.confirmsSubmissionExecutionOnOwnAttribution === true &&
            (record === undefined || !record.terminal)
          ) {
            emit(
              inv,
              'submission.executed',
              { submissionId: payload.inputId, turnId },
              { turnId, inputId: payload.inputId }
            )
          }
        } else if (payload.ownership === 'unknown') {
          if (
            inv.pendingOwnTurnSubmissionId !== undefined &&
            inv.pendingOwnTurnContestedByTurnId === undefined
          ) {
            inv.pendingOwnTurnContestedByTurnId = turnId
          }
        }
        return
      }
      case 'assistant.message.started':
      case 'assistant.message.delta':
      case 'assistant.message.completed':
      case 'tool.call.started':
        if (event.turnId !== undefined && event.turnId === inv.currentTurnId) {
          inv.currentTurnRequestInFlight = true
          maybeRequestPreemptInterrupt(inv)
        }
        return
      // biome-ignore lint/suspicious/noFallthroughSwitchClause: intentional — turn.completed increments the counter then shares the turn-end projection below.
      case 'turn.completed':
        inv.turnsCompleted = (inv.turnsCompleted ?? 0) + 1
      // falls through to the shared turn-end projection below
      case 'turn.failed':
      case 'turn.interrupted': {
        const terminalTurnId = event.turnId
        const targeted =
          terminalTurnId !== undefined && inv.preemptInterruptTurnId === terminalTurnId
        if (targeted) inv.preemptInterruptTurnId = undefined
        if (
          terminalTurnId !== undefined &&
          inv.currentTurnId !== undefined &&
          terminalTurnId !== inv.currentTurnId
        ) {
          // A drained successor's user row can precede the prior turn's
          // interrupt marker. Preserve the successor projection; it becomes
          // interruptible only after its own request evidence arrives.
          if (targeted) maybeRequestPreemptInterrupt(inv)
          return
        }
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.unattributedTurnId = undefined
        inv.currentTurnStartedAt = undefined
        inv.currentTurnRequestInFlight = false
        if (inv.state !== 'exited' && inv.state !== 'failed' && inv.state !== 'disposed') {
          inv.state = 'ready'
        }
        // Schedule drain if there are pending inputs and we transitioned to ready
        scheduleDrain(inv)
        scheduleAdmissionDrain(inv)
        return
      }
      case 'invocation.stopping':
        inv.state = 'stopping'
        inv.terminalReason = 'stopping'
        evictQueue(inv, REASON_INVOCATION_STOPPING)
        return
      case 'invocation.exited': {
        inv.state = 'exited'
        inv.terminalEmitted = true
        inv.terminalReason = 'exited'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.unattributedTurnId = undefined
        inv.currentTurnStartedAt = undefined
        const payload = event.payload as { exitCode?: unknown; signal?: unknown } | undefined
        if (payload && 'exitCode' in payload) {
          inv.exitCode = payload.exitCode as number | null | undefined
        }
        if (payload && 'signal' in payload) {
          inv.signal = payload.signal as string | null | undefined
        }
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      }
      case 'invocation.failed':
        // Retryable invocation failures are evidence of a provider attempt,
        // matching HRC's broker-failure contract. They do not close the active
        // turn, evict input, or turn an otherwise live seat terminal.
        if (event.payload.retryable === true) return
        inv.state = 'failed'
        inv.terminalEmitted = true
        inv.terminalReason = 'failed'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.unattributedTurnId = undefined
        inv.currentTurnStartedAt = undefined
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      case 'invocation.disposed':
        inv.state = 'disposed'
        inv.disposedEmitted = true
        inv.terminalReason = 'disposed'
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        inv.unattributedTurnId = undefined
        inv.currentTurnStartedAt = undefined
        return
      case 'continuation.updated':
        inv.continuation = event.payload as ContinuationUpdate
        return
      case 'continuation.cleared':
        inv.continuation = undefined
        return
    }
  }

  return applyEventState
}
