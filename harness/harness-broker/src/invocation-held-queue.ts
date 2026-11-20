import type {
  BrokerQueueEntry,
  InputId,
  SubmissionWithdrawRequest,
  SubmissionWithdrawResponse,
} from 'spaces-harness-broker-protocol'
import { errorMessage } from './errors'
import type { InvocationDelivery } from './invocation-delivery'
import type {
  BrokerHeldSubmission,
  EmitFn,
  Invocation,
  RetryableNotWrittenCarrier,
  SubmissionRecord,
} from './invocation-model'
import type { SubmissionTerminals } from './invocation-submission-terminals'

export interface HeldQueueDeps {
  emit: EmitFn
  now: () => Date
  invocations: Map<string, Invocation>
  delivery: Pick<InvocationDelivery, 'applyAndEmit'>
  terminals: Pick<SubmissionTerminals, 'rejectSubmission' | 'rejectAdmittedExecution'>
}

export type HeldQueue = ReturnType<typeof createHeldQueue>

/** Remove one broker-held entry by submission id and stop its TTL timer. */
export function takeHeldSubmission(
  inv: Invocation,
  submissionId: string
): { item: BrokerHeldSubmission; position: number } | undefined {
  const position = inv.brokerQueue.findIndex((item) => item.record.submissionId === submissionId)
  if (position < 0) return undefined
  const [item] = inv.brokerQueue.splice(position, 1)
  if (item === undefined) return undefined
  if (item.timer !== undefined) clearTimeout(item.timer)
  return { item, position }
}

export function queueEntry(item: BrokerHeldSubmission, position: number): BrokerQueueEntry {
  return {
    submissionId: item.record.submissionId,
    origin: item.record.origin,
    class: item.class,
    ...(item.ttlMs !== undefined ? { ttlMs: item.ttlMs } : {}),
    position,
  }
}

/** Whether the harness reports inputs waiting in its own local queue. */
function harnessLocalQueued(inv: Invocation): boolean {
  return (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
}

/** A driver that owns its queue fences broker admission while that queue holds input. */
export function hasDriverOwnedAdmissionFence(inv: Invocation): boolean {
  return inv.driver.blocksAdmissionWhileHarnessLocalQueued === true && harnessLocalQueued(inv)
}

function hasDriverBlockedHeldSubmission(inv: Invocation): boolean {
  return inv.brokerQueue.some(
    (item) =>
      !item.record.terminal && inv.driver.admissionRejectionReason?.(item.class) !== undefined
  )
}

function retryableNotWrittenOf(error: unknown): RetryableNotWrittenCarrier | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const candidate = error as Partial<RetryableNotWrittenCarrier>
  return candidate.retryableNotWritten === true && candidate.deliveryEvidence === 'not_written'
    ? (candidate as RetryableNotWrittenCarrier)
    : undefined
}

/**
 * The broker-held queue for queue and preempt submissions: hold with TTL,
 * withdraw, the promise-guarded drain into the delivery door, and the
 * interrupt a preempt needs before its body can be written.
 */
export function createHeldQueue(deps: HeldQueueDeps) {
  const { emit, now, invocations } = deps
  const { applyAndEmit } = deps.delivery
  const { rejectSubmission, rejectAdmittedExecution } = deps.terminals

  function expireHeldSubmission(inv: Invocation, submissionId: string): void {
    const taken = takeHeldSubmission(inv, submissionId)
    if (taken === undefined || taken.item.record.terminal) return
    emit(inv, 'queue.expired', { submissionId })
    emit(inv, 'submission.expired', { submissionId })
    scheduleAdmissionDrain(inv)
  }

  async function withdrawHeldSubmission(
    req: SubmissionWithdrawRequest
  ): Promise<SubmissionWithdrawResponse> {
    const matches: Array<{ inv: Invocation; record: SubmissionRecord }> = []
    for (const inv of invocations.values()) {
      for (const record of inv.submissions.values()) {
        if (
          ('submissionId' in req && record.submissionId === req.submissionId) ||
          ('envelopeId' in req && record.origin.envelopeId === req.envelopeId)
        ) {
          matches.push({ inv, record })
        }
      }
    }
    if (matches.length === 0) return { outcome: 'unknown' }

    let withdrawn = false
    let accepted = false
    for (const { inv, record } of matches) {
      if (record.terminal) continue
      const taken = takeHeldSubmission(inv, record.submissionId)
      if (taken !== undefined) {
        emit(inv, 'queue.withdrawn', {
          submissionId: record.submissionId,
          reason: req.reason,
          position: taken.position,
        })
        emit(inv, 'submission.withdrawn', {
          submissionId: record.submissionId,
          reason: req.reason,
        })
        scheduleAdmissionDrain(inv)
        withdrawn = true
        continue
      }
      if (inv.heldSteers?.has(record) === true) {
        // A held steer was never handed over: withdrawing it is definite.
        inv.heldSteers.delete(record)
        emit(inv, 'submission.withdrawn', {
          submissionId: record.submissionId,
          reason: req.reason,
        })
        withdrawn = true
        continue
      }
      if (inv.driver.cancelInput !== undefined) {
        const result = await inv.driver.cancelInput(record.submissionId as InputId, req.reason)
        if (result.outcome === 'cancelled') {
          emit(inv, 'submission.withdrawn', {
            submissionId: record.submissionId,
            reason: req.reason,
          })
          if (inv.pendingOwnTurnSubmissionId === record.submissionId) {
            inv.pendingOwnTurnSubmissionId = undefined
          }
          scheduleAdmissionDrain(inv)
          withdrawn = true
          continue
        }
        if (result.outcome === 'executed' && result.turnId !== undefined) {
          emit(
            inv,
            'submission.executed',
            { submissionId: record.submissionId, turnId: result.turnId },
            { turnId: result.turnId, inputId: record.submissionId as InputId }
          )
        }
      }
      accepted = true
    }
    if (withdrawn) return { outcome: 'withdrawn' }
    return { outcome: 'not_held', state: accepted ? 'accepted' : 'terminal' }
  }

  function holdSubmission(
    inv: Invocation,
    record: SubmissionRecord,
    admissionClass: 'queue' | 'preempt',
    ttlMs?: number | undefined
  ): void {
    const item: BrokerHeldSubmission = {
      record,
      class: admissionClass,
      ...(ttlMs !== undefined ? { ttlMs, expiresAt: now().getTime() + ttlMs } : {}),
    }
    if (admissionClass === 'preempt') inv.brokerQueue.unshift(item)
    else inv.brokerQueue.push(item)
    if (ttlMs !== undefined) {
      item.timer = setTimeout(
        () => expireHeldSubmission(inv, record.submissionId),
        Math.max(0, ttlMs)
      )
    }
    const position = inv.brokerQueue.indexOf(item)
    emit(inv, 'queue.enqueued', {
      submissionId: record.submissionId,
      class: admissionClass,
      position,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
    })
  }

  function rejectDriverBlockedHeldSubmissions(inv: Invocation): void {
    let index = 0
    while (index < inv.brokerQueue.length) {
      const item = inv.brokerQueue[index]
      if (item === undefined || item.record.terminal) {
        index += 1
        continue
      }
      const reason = inv.driver.admissionRejectionReason?.(item.class)
      if (reason === undefined) {
        index += 1
        continue
      }
      inv.brokerQueue.splice(index, 1)
      if (item.timer !== undefined) clearTimeout(item.timer)
      rejectSubmission(inv, item.record, 'capability', reason)
    }
  }

  function reholdRetryableNotWritten(
    inv: Invocation,
    item: BrokerHeldSubmission,
    error: RetryableNotWrittenCarrier
  ): void {
    item.record.deliveryEvidence = 'not_written'
    inv.brokerQueue.unshift(item)
    if (item.expiresAt !== undefined) {
      const remaining = item.expiresAt - now().getTime()
      if (remaining <= 0) {
        expireHeldSubmission(inv, item.record.submissionId)
        return
      }
      item.timer = setTimeout(() => expireHeldSubmission(inv, item.record.submissionId), remaining)
    }
    emit(inv, 'diagnostic', {
      level: 'info',
      source: 'broker',
      kind: 'submission_retryable_not_written',
      message: 'Driver proved the held submission was not written and remains retryable',
      data: {
        submissionId: item.record.submissionId,
        ...(error.receipt === undefined ? {} : { receipt: error.receipt }),
      },
    })
  }

  function scheduleAdmissionDrain(inv: Invocation): void {
    if (inv.admissionDrainPromise !== undefined) return
    inv.admissionDrainPromise = Promise.resolve()
      .then(() => drainAdmissionQueue(inv))
      .finally(() => {
        inv.admissionDrainPromise = undefined
        const head = inv.brokerQueue[0]
        const quiescenceBlocked = head?.class === 'preempt' && harnessLocalQueued(inv)
        const driverQueueBlocked = hasDriverOwnedAdmissionFence(inv)
        if (
          hasDriverBlockedHeldSubmission(inv) ||
          (inv.state === 'ready' &&
            inv.pendingOwnTurnSubmissionId === undefined &&
            head !== undefined &&
            !quiescenceBlocked &&
            !driverQueueBlocked)
        ) {
          scheduleAdmissionDrain(inv)
        }
      })
  }

  async function drainAdmissionQueue(inv: Invocation): Promise<void> {
    // Drivers can lose a capability after admission while a submission is
    // broker-held. Re-evaluate those records before seat-state gates so an
    // active turn cannot strand a preempt whose terminal is no longer
    // observable. Unaffected classes remain held in their original order.
    rejectDriverBlockedHeldSubmissions(inv)
    if (inv.state !== 'ready') return
    if (inv.pendingOwnTurnSubmissionId !== undefined) return
    if (hasDriverOwnedAdmissionFence(inv)) return
    const head = inv.brokerQueue[0]
    if (head === undefined) return
    if (
      head.class === 'preempt' &&
      head.record.class === 'preempt' &&
      head.record.terminal === false &&
      harnessLocalQueued(inv)
    ) {
      return
    }
    inv.brokerQueue.shift()
    if (head.timer !== undefined) clearTimeout(head.timer)
    try {
      await applyAndEmit(inv, head.record.input)
      head.timer = undefined
    } catch (error) {
      const retryable = retryableNotWrittenOf(error)
      if (retryable !== undefined && hasDriverOwnedAdmissionFence(inv)) {
        reholdRetryableNotWritten(inv, head, retryable)
        return
      }
      rejectAdmittedExecution(inv, head.record, error)
    }
  }

  async function requestPreemptInterrupt(inv: Invocation, record: SubmissionRecord): Promise<void> {
    const turnId = inv.currentTurnId
    if (turnId === undefined || inv.preemptInterruptTurnId !== undefined) return
    if (inv.driver.preemptMode === 'quiescence' && !inv.currentTurnRequestInFlight) return
    inv.preemptInterruptTurnId = turnId
    emit(inv, 'interrupt.requested', {
      submissionId: record.submissionId,
      turnId,
    })
    try {
      const result = await inv.driver.interrupt({
        invocationId: inv.invocationId,
        scope: 'turn',
        reason: `submission.preempt:${record.submissionId}`,
      })
      if (!result.accepted) {
        emit(inv, 'interrupt.failed', {
          submissionId: record.submissionId,
          turnId,
          reason: result.reason ?? result.effect,
        })
        if (inv.preemptInterruptTurnId === turnId) inv.preemptInterruptTurnId = undefined
        // The preempt body is still broker-held: the interrupt was a
        // precondition for writing it, so a failed interrupt means nothing
        // reached the harness and the refusal stays terminal.
        rejectAdmittedExecution(inv, record, result.reason ?? result.effect, {
          deliveryEvidence: 'not_written',
        })
        return
      }
      emit(inv, 'interrupt.landed', {
        submissionId: record.submissionId,
        turnId,
      })
      scheduleAdmissionDrain(inv)
    } catch (error) {
      emit(inv, 'interrupt.failed', {
        submissionId: record.submissionId,
        turnId,
        reason: errorMessage(error),
      })
      if (inv.preemptInterruptTurnId === turnId) inv.preemptInterruptTurnId = undefined
      // Same boundary as above: the interrupt threw before the held body was
      // ever written.
      rejectAdmittedExecution(inv, record, error, { deliveryEvidence: 'not_written' })
    }
  }

  function maybeRequestPreemptInterrupt(inv: Invocation): void {
    const preempt = inv.brokerQueue.find((item) => item.class === 'preempt')
    if (preempt === undefined || inv.driver.preemptMode !== 'quiescence') return
    void requestPreemptInterrupt(inv, preempt.record)
  }

  return {
    holdSubmission,
    withdrawHeldSubmission,
    scheduleAdmissionDrain,
    requestPreemptInterrupt,
    maybeRequestPreemptInterrupt,
  }
}
