import type {
  AdmissionLayer,
  InputId,
  InvocationInputResponse,
  SubmissionResponse,
} from 'spaces-harness-broker-protocol'
import type { DeliveryEvidence } from './drivers/driver'
import { deliveryEvidenceOf } from './drivers/driver'
import { errorMessage } from './errors'
import { takeHeldSubmission } from './invocation-held-queue'
import type { EmitFn, Invocation, SubmissionRecord } from './invocation-model'

export interface SubmissionTerminalsDeps {
  emit: EmitFn
}

export type SubmissionTerminals = ReturnType<typeof createSubmissionTerminals>

/**
 * How a submission fails and how teardown settles it: the refusals the broker
 * authors, the typed write evidence each one reports, and the exactly-once
 * terminal every submission reaches when the invocation ends.
 */
export function createSubmissionTerminals(deps: SubmissionTerminalsDeps) {
  const { emit } = deps

  function rejectSubmission(
    inv: Invocation,
    record: SubmissionRecord,
    layer: AdmissionLayer,
    reason: string
  ): SubmissionResponse {
    emit(inv, 'admission.rejected', {
      submissionId: record.submissionId,
      class: record.class,
      layer,
      reason,
    })
    emit(inv, 'submission.rejected', { submissionId: record.submissionId, reason })
    return { submissionId: record.submissionId, admission: 'rejected', reason }
  }

  function rejectAdmittedExecution(
    inv: Invocation,
    record: SubmissionRecord,
    error: unknown,
    options?: {
      /** Typed evidence from a caller that already classified the failure. */
      deliveryEvidence?: DeliveryEvidence | undefined
      /** Set when the caller already emitted input.rejected for this attempt. */
      inputRejectedEmitted?: boolean | undefined
    }
  ): void {
    takeHeldSubmission(inv, record.submissionId)
    const reason = errorMessage(error)
    // A driver that already began writing may have left the body in the
    // harness. Reason text alone cannot express that, so the driver's TYPED
    // evidence decides; anything a driver touched defaults to possibly-written
    // (T-08204 rev 3 §4/§5).
    const evidence = options?.deliveryEvidence ?? deliveryEvidenceOf(error) ?? 'possibly_written'
    // The attempt is reported once, with its explicit write evidence: consumers
    // read no-write proof from input.rejected only (T-12119).
    if (options?.inputRejectedEmitted !== true) {
      emit(
        inv,
        'input.rejected',
        { inputId: record.submissionId as InputId, reason, deliveryEvidence: evidence },
        { inputId: record.submissionId as InputId }
      )
    }
    if (evidence === 'possibly_written') {
      // No terminal submission.rejected: a late native user row must still be
      // able to report this body consumed. The submission stays undisposed.
      return
    }
    emit(inv, 'submission.rejected', {
      submissionId: record.submissionId,
      reason,
    })
  }

  function rejectQueueInput(
    inv: Invocation,
    inputId: InputId,
    reason: string,
    deliveryEvidence?: DeliveryEvidence | undefined
  ): InvocationInputResponse {
    emit(
      inv,
      'input.rejected',
      {
        inputId,
        reason,
        ...(deliveryEvidence !== undefined ? { deliveryEvidence } : {}),
      },
      { inputId }
    )
    return {
      inputId,
      accepted: false,
      disposition: 'rejected',
      reason,
    }
  }

  /** Queue eviction: reject everything pending when the invocation terminates or stops. */
  function evictQueue(inv: Invocation, reason: string): void {
    if (inv.pendingOwnTurnSubmissionId !== undefined) {
      const pendingId = inv.pendingOwnTurnSubmissionId
      inv.pendingOwnTurnSubmissionId = undefined
      inv.pendingOwnTurnContestedByTurnId = undefined
      // T-13687 B: this body was already handed to the driver and may have been
      // written, so its teardown fate is ambiguous. `cancelled` stays for
      // inputs never handed over (inv.pending, inv.brokerQueue).
      emit(
        inv,
        'submission.lost',
        { submissionId: pendingId, reason: 'teardown' },
        { inputId: pendingId }
      )
    }
    while (inv.pending.length > 0) {
      const item = inv.pending.shift()
      if (item === undefined) return
      emit(
        inv,
        'input.rejected',
        { inputId: item.inputId, reason, deliveryEvidence: 'not_written' },
        { inputId: item.inputId }
      )
      emit(inv, 'submission.cancelled', {
        submissionId: item.inputId,
        reason: 'teardown',
      })
    }
    while (inv.brokerQueue.length > 0) {
      const item = inv.brokerQueue.shift()
      if (item === undefined) return
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.cancelled', {
        submissionId: item.record.submissionId,
        principalRef: 'broker',
      })
      emit(inv, 'submission.cancelled', {
        submissionId: item.record.submissionId,
        reason: 'teardown',
      })
    }
    // Steers the broker held and never handed to the driver (T-13689).
    for (const record of [...(inv.heldSteers ?? [])]) {
      inv.heldSteers?.delete(record)
      if (record.terminal) continue
      emit(inv, 'submission.cancelled', { submissionId: record.submissionId, reason: 'teardown' })
    }
  }

  /**
   * T-13687 B: at invocation exit or failure every submission gets a terminal.
   * Queue eviction settles only what the broker still held; a delivered body
   * whose attempt failed possibly_written, or one the harness never confirmed,
   * has no other evidence left to come, so it is settled lost exactly once.
   */
  function settleUndisposedSubmissions(inv: Invocation): void {
    for (const record of [...inv.submissions.values()]) {
      if (record.terminal || inv.submissionDispositions.has(record.submissionId)) continue
      emit(
        inv,
        'submission.lost',
        { submissionId: record.submissionId, reason: 'teardown' },
        { inputId: record.submissionId as InputId }
      )
    }
  }

  return {
    rejectSubmission,
    rejectAdmittedExecution,
    rejectQueueInput,
    evictQueue,
    settleUndisposedSubmissions,
  }
}
