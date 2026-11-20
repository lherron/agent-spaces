import type { TurnId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { ApplyInputResult } from './drivers/driver'
import { withDeliveryEvidence } from './drivers/driver'
import { BrokerError, errorMessage } from './errors'
import type { EmitFn, Invocation, InvocationInputWithId } from './invocation-model'

export interface InvocationDeliveryDeps {
  emit: EmitFn
}

export type InvocationDelivery = ReturnType<typeof createInvocationDelivery>

/**
 * The one door an input takes into the driver to start a turn, and the legacy
 * invocation.input FIFO that feeds it while the seat is busy.
 */
export function createInvocationDelivery(deps: InvocationDeliveryDeps) {
  const { emit } = deps

  /**
   * Emit broker-owned input.accepted, then call driver.applyInputNow, then
   * GUARANTEE the `turn.started` bracket from the returned turnId (T-04846).
   *
   * The broker no longer depends on a driver hook (e.g. Claude
   * `UserPromptSubmit`) to open the turn: that hook does not fire for an idle
   * dispatch, leaving the turn body/terminal orphaned with no open bracket.
   * Instead, once the input is delivered and `applyInputNow` returns the
   * authoritative turnId, the broker synthesizes exactly one `turn.started`
   * (provenance `source:'broker-delivery'`) BEFORE any body/terminal event.
   * If the driver/hook ALSO observes the start for the same turnId, `emit`
   * dedupes it (whichever path lands first wins). This is the single code path
   * for both immediate application and drain. `attempted_steer` does not flow
   * through here, so it never gets a synthetic start.
   */
  async function applyAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<{ turnId?: TurnId | undefined }> {
    // Broker owns input.accepted emission — before the driver applies the input
    const { inputId } = input
    if (inv.submissions.has(inputId)) {
      if (
        inv.pendingOwnTurnSubmissionId !== undefined &&
        inv.pendingOwnTurnSubmissionId !== inputId
      ) {
        // Refused before the driver is called: nothing was written.
        throw withDeliveryEvidence(
          new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Seat delivery is busy', {
            invocationId: inv.invocationId,
            submissionId: inv.pendingOwnTurnSubmissionId,
          }),
          'not_written'
        )
      }
      inv.pendingOwnTurnSubmissionId = inputId
      inv.pendingOwnTurnContestedByTurnId = undefined
      inv.pendingOwnTurnUncorrelatableTurnId = undefined
      inv.stalePendingProbeReported = false
    }
    emit(inv, 'input.accepted', { inputId, disposition: 'started' }, { inputId })
    let result: ApplyInputResult
    try {
      result = await inv.driver.applyInputNow(input)
    } catch (error) {
      if (inv.pendingOwnTurnSubmissionId === inputId) {
        inv.pendingOwnTurnSubmissionId = undefined
        inv.pendingOwnTurnContestedByTurnId = undefined
      }
      throw error
    }
    // Broker-guaranteed turn.started: synthesize the bracket from the delivered
    // input's turnId. Deduped in emit() so it never double-opens a turn the
    // driver/hook also reports. Emitted synchronously after delivery so it
    // strictly precedes the (asynchronously-arriving) hook body/terminal events.
    if (result.turnId !== undefined && inv.driver.bracketMintingMode !== 'harness-evidence') {
      emit(
        inv,
        'turn.started',
        { turnId: result.turnId, source: 'broker-delivery', inputId },
        { turnId: result.turnId, inputId }
      )
      if (inv.submissions.has(inputId)) {
        if (result.deliveryDisposition === 'rejected') {
          emit(
            inv,
            'submission.rejected',
            {
              submissionId: inputId,
              reason: result.rejectionReason ?? 'delivery-rejected',
            },
            { turnId: result.turnId, inputId }
          )
        } else {
          emit(
            inv,
            'submission.executed',
            { submissionId: inputId, turnId: result.turnId },
            { turnId: result.turnId, inputId }
          )
        }
      }
    }
    return result
  }

  /** Drain the legacy pending FIFO: promise-guarded, at most one drain in flight per ready window. */
  function scheduleDrain(inv: Invocation): void {
    if (inv.drainPromise) return
    if (inv.pending.length === 0) return
    if (inv.state !== 'ready') return
    if (inv.pendingOwnTurnSubmissionId !== undefined) return
    inv.drainPromise = doDrain(inv).finally(() => {
      inv.drainPromise = undefined
      // Reschedule if invocation is still ready with pending inputs — prevents
      // stalling when a mid-drain failure leaves items in the queue.
      if (
        inv.state === 'ready' &&
        inv.pendingOwnTurnSubmissionId === undefined &&
        inv.pending.length > 0
      ) {
        scheduleDrain(inv)
      }
    })
  }

  async function doDrain(inv: Invocation): Promise<void> {
    while (
      inv.pending.length > 0 &&
      inv.state === 'ready' &&
      inv.pendingOwnTurnSubmissionId === undefined
    ) {
      const head = inv.pending.shift()
      if (head === undefined) return
      try {
        await applyAndEmit(inv, head.input)
      } catch (err) {
        // Input failed at the driver level — reject this item and continue
        // draining; the while-loop guard re-checks state before the next item.
        const reason = errorMessage(err)
        emit(inv, 'input.rejected', { inputId: head.inputId, reason }, { inputId: head.inputId })
        emit(inv, 'submission.rejected', { submissionId: head.inputId, reason })
      }
    }
  }

  return { applyAndEmit, scheduleDrain }
}
