import type {
  AdmissionLayer,
  BrokerQueueEntry,
  InputId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  SubmissionClass,
  SubmissionEnqueueRequest,
  SubmissionOrigin,
  SubmissionResponse,
  SubmissionWithdrawRequest,
  SubmissionWithdrawResponse,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { ApplyInputResult, DeliveryEvidence } from './drivers/driver'
import { deliveryEvidenceOf, steerRequiresOwnTurnOf, withDeliveryEvidence } from './drivers/driver'
import { BrokerError } from './errors'
import { stableJsonStringify } from './event-ledger'
import { REASON_STEER_NOT_SUPPORTED, normalizeResponseFormat } from './invocation-constants'
import type {
  BrokerHeldSubmission,
  EmitFn,
  Invocation,
  InvocationInputWithId,
  InvocationManagerOptions,
  RetryableNotWrittenCarrier,
  SubmissionRecord,
  SubmissionRequest,
} from './invocation-model'
import { TmuxPaneNotQuiescentError } from './runtime/tmux'

export interface InvocationAdmissionDeps {
  emit: EmitFn
  now: () => Date
  invocations: Map<string, Invocation>
  authorizeSubmission: NonNullable<InvocationManagerOptions['authorizeSubmission']>
  /** Delay between steer attempts a pane refused before paste. */
  steerRetryIntervalMs: number
}

/** Tool calls that put a question to the human; a steer must not answer them. */
const ASK_TOOL_NAMES = new Set(['AskUserQuestion', 'request_user_input'])

/** States that can never deliver a held steer again. */
const STEER_CLOSED_STATES = new Set(['stopping', 'exited', 'failed', 'disposed'])

/**
 * Outcome of one steer attempt. `retry` and `again` are silent: the broker holds
 * the steer and tries again, and only a `final` failure is reported.
 */
type SteerAttempt =
  | { kind: 'delivered'; started?: { turnId?: TurnId | undefined } | undefined }
  | { kind: 'retry' }
  | { kind: 'again' }
  | { kind: 'final'; error: unknown; evidence: DeliveryEvidence }

/** A pane refusal raised before the first paste: nothing was written, so it can be retried. */
function paneNotReadyBeforePaste(error: unknown): boolean {
  return error instanceof TmuxPaneNotQuiescentError && error.phase === 'before_paste'
}

export type InvocationAdmission = ReturnType<typeof createInvocationAdmission>

/**
 * Submission admission, broker-held queue, drain, and delivery: everything that
 * decides whether and when an input reaches the driver.
 */
export function createInvocationAdmission(deps: InvocationAdmissionDeps) {
  const { emit, now, invocations, authorizeSubmission, steerRetryIntervalMs } = deps

  function nextSubmissionId(inv: Invocation): string {
    inv.submissionCounter += 1
    return `submission_${inv.invocationId}_${inv.submissionCounter}`
  }

  function requestToInput(submissionId: string, req: SubmissionRequest): InvocationInputWithId {
    return {
      inputId: submissionId as InputId,
      kind: 'user',
      content: [{ type: 'text', text: req.body }],
      ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
      metadata: {
        submissionId,
        principalRef: req.origin.principalRef,
        ...(req.origin.scopeRef !== undefined ? { scopeRef: req.origin.scopeRef } : {}),
        ...(req.origin.envelopeId !== undefined ? { envelopeId: req.origin.envelopeId } : {}),
      },
    }
  }

  /** Canonical request identity for caller-minted submissionId replay (T-13689). */
  function submissionFingerprint(admissionClass: SubmissionClass, req: SubmissionRequest): string {
    const extended = req as SubmissionEnqueueRequest
    return stableJsonStringify({
      class: admissionClass,
      origin: req.origin,
      body: req.body,
      responseFormat: normalizeResponseFormat(req.responseFormat) ?? null,
      freshContext: req.freshContext ?? null,
      ttlMs: extended.ttlMs ?? null,
      turnPolicy: extended.turnPolicy ?? null,
    })
  }

  /**
   * Run one public submission's admission at most once per caller-minted id. A
   * repeat with the same id and request returns the first admission reply and
   * creates nothing; the same id with a different request is invalid params.
   */
  function admitOnce(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest,
    admit: (record: SubmissionRecord) => Promise<SubmissionResponse>
  ): Promise<SubmissionResponse> {
    const fingerprint = submissionFingerprint(admissionClass, req)
    if (req.submissionId !== undefined) {
      const existing = inv.submissions.get(req.submissionId)
      if (existing !== undefined) {
        if (existing.requestFingerprint === fingerprint && existing.admissionReply !== undefined) {
          return existing.admissionReply
        }
        return Promise.reject(
          new BrokerError(
            -32602 as BrokerErrorCode,
            `submissionId ${req.submissionId} was already used for a different request`,
            { invocationId: inv.invocationId, submissionId: req.submissionId }
          )
        )
      }
    }
    const record = registerSubmission(inv, admissionClass, req)
    record.requestFingerprint = fingerprint
    const reply = admit(record)
    record.admissionReply = reply
    return reply
  }

  function registerSubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest
  ): SubmissionRecord {
    const submissionId = req.submissionId ?? nextSubmissionId(inv)
    const record: SubmissionRecord = {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      input: requestToInput(submissionId, req),
      turnPolicy:
        admissionClass === 'steer'
          ? 'open'
          : ((req as SubmissionEnqueueRequest).turnPolicy ?? 'open'),
      terminal: false,
    }
    inv.submissions.set(submissionId, record)
    emit(inv, 'admission.requested', {
      submissionId,
      class: admissionClass,
      origin: req.origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: record.turnPolicy } : {}),
      ...(req.freshContext !== undefined ? { freshContext: req.freshContext } : {}),
    })
    return record
  }

  function registerLegacySubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    input: InvocationInputWithId
  ): SubmissionRecord {
    const origin: SubmissionOrigin = {
      principalRef: input.metadata?.['principalRef'] ?? 'legacy:invocation.input',
      ...(input.metadata?.['scopeRef'] !== undefined
        ? { scopeRef: input.metadata['scopeRef'] }
        : {}),
      ...(input.metadata?.['envelopeId'] !== undefined
        ? { envelopeId: input.metadata['envelopeId'] }
        : {}),
    }
    const record: SubmissionRecord = {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      input,
      turnPolicy: 'open',
      terminal: false,
    }
    inv.submissions.set(input.inputId, record)
    emit(inv, 'admission.requested', {
      submissionId: input.inputId,
      class: admissionClass,
      origin,
      ...(admissionClass !== 'steer' ? { turnPolicy: 'open' } : {}),
    })
    return record
  }

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

  async function checkAdmission(
    inv: Invocation,
    record: SubmissionRecord,
    req: SubmissionRequest
  ): Promise<SubmissionResponse | undefined> {
    // A steer to a driver without a steer door goes through its own queue
    // (T-13689), so the class that must be supported is the routed one.
    const routedClass =
      record.class === 'steer' && steerRoutesThroughQueue(inv) ? 'queue' : record.class
    if (!inv.capabilities.admission.classes.includes(routedClass)) {
      return rejectSubmission(inv, record, 'capability', `unsupported:${record.class}`)
    }
    const driverRejection = inv.driver.admissionRejectionReason?.(routedClass)
    if (driverRejection !== undefined) {
      return rejectSubmission(inv, record, 'capability', driverRejection)
    }
    if (req.freshContext === true) {
      return rejectSubmission(inv, record, 'capability', 'fresh-context-unsupported')
    }
    // A steer to a starting invocation is admitted and held until it is ready
    // (broker-steer-one-door); only a closing or closed one refuses it.
    const steerHoldable = record.class === 'steer' && inv.state === 'starting'
    if (inv.state !== 'ready' && inv.state !== 'turn_active' && !steerHoldable) {
      return rejectSubmission(inv, record, 'state', `invalid-state:${inv.state}`)
    }
    // A steer is never refused by a busy or guarded seat: the broker holds it
    // (T-08527, T-13687 C, T-13689). Exclusive is not best effort and stays busy.
    if (inv.pendingOwnTurnSubmissionId !== undefined && record.class === 'exclusive') {
      return rejectSubmission(inv, record, 'state', 'busy')
    }
    const authorized = await authorizeSubmission({
      invocationId: inv.invocationId,
      class: record.class,
      origin: record.origin,
      ...(inv.currentTurnId !== undefined ? { activeTurnId: inv.currentTurnId } : {}),
      ...(inv.state === 'turn_active' && inv.unattributedTurnId === undefined
        ? { activeTurnPolicy: inv.currentTurnPolicy }
        : {}),
    })
    if (!authorized) {
      return rejectSubmission(inv, record, 'authority', 'authority-denied')
    }
    return undefined
  }

  function admitSubmission(inv: Invocation, record: SubmissionRecord): SubmissionResponse {
    emit(inv, 'admission.admitted', {
      submissionId: record.submissionId,
      class: record.class,
    })
    return { submissionId: record.submissionId, admission: 'admitted' }
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
    const heldIndex = inv.brokerQueue.findIndex(
      (item) => item.record.submissionId === record.submissionId
    )
    if (heldIndex >= 0) {
      const [held] = inv.brokerQueue.splice(heldIndex, 1)
      if (held?.timer !== undefined) clearTimeout(held.timer)
    }
    const reason = error instanceof Error ? error.message : String(error)
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

  function queueEntry(item: BrokerHeldSubmission, position: number): BrokerQueueEntry {
    return {
      submissionId: item.record.submissionId,
      origin: item.record.origin,
      class: item.class,
      ...(item.ttlMs !== undefined ? { ttlMs: item.ttlMs } : {}),
      position,
    }
  }

  function expireHeldSubmission(inv: Invocation, submissionId: string): void {
    const index = inv.brokerQueue.findIndex((item) => item.record.submissionId === submissionId)
    if (index < 0) return
    const [item] = inv.brokerQueue.splice(index, 1)
    if (item === undefined || item.record.terminal) return
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
      const position = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === record.submissionId
      )
      if (position < 0 && inv.heldSteers?.has(record) === true) {
        // A held steer was never handed over: withdrawing it is definite.
        inv.heldSteers.delete(record)
        emit(inv, 'submission.withdrawn', {
          submissionId: record.submissionId,
          reason: req.reason,
        })
        withdrawn = true
        continue
      }
      if (position < 0) {
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
        continue
      }

      const [item] = inv.brokerQueue.splice(position, 1)
      if (item === undefined) {
        accepted = true
        continue
      }
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.withdrawn', {
        submissionId: record.submissionId,
        reason: req.reason,
        position,
      })
      emit(inv, 'submission.withdrawn', {
        submissionId: record.submissionId,
        reason: req.reason,
      })
      scheduleAdmissionDrain(inv)
      withdrawn = true
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

  function hasDriverBlockedHeldSubmission(inv: Invocation): boolean {
    return inv.brokerQueue.some(
      (item) =>
        !item.record.terminal && inv.driver.admissionRejectionReason?.(item.class) !== undefined
    )
  }

  function hasDriverOwnedAdmissionFence(inv: Invocation): boolean {
    return (
      inv.driver.blocksAdmissionWhileHarnessLocalQueued === true &&
      (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
    )
  }

  function retryableNotWrittenOf(error: unknown): RetryableNotWrittenCarrier | undefined {
    if (typeof error !== 'object' || error === null) return undefined
    const candidate = error as Partial<RetryableNotWrittenCarrier>
    return candidate.retryableNotWritten === true && candidate.deliveryEvidence === 'not_written'
      ? (candidate as RetryableNotWrittenCarrier)
      : undefined
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
        const quiescenceBlocked =
          head?.class === 'preempt' &&
          (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
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
      (inv.driver.probeAdmissionState?.().harnessLocalQueueDepth ?? 0) > 0
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
        reason: error instanceof Error ? error.message : String(error),
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

  // ---------------------------------------------------------------------------
  // Drain logic — promise-guarded, at most one drain in flight per ready window
  // ---------------------------------------------------------------------------
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
        emit(
          inv,
          'input.rejected',
          {
            inputId: head.inputId,
            reason: String(err instanceof Error ? err.message : err),
          },
          { inputId: head.inputId }
        )
        emit(inv, 'submission.rejected', {
          submissionId: head.inputId,
          reason: String(err instanceof Error ? err.message : err),
        })
      }
    }
  }

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

  /** Whether this driver lacks a steer door and so takes steers through its queue. */
  function steerRoutesThroughQueue(inv: Invocation): boolean {
    const classes = inv.capabilities.admission.classes
    return (
      classes.includes('queue') &&
      (!classes.includes('steer') || inv.driver.applySteerNow === undefined)
    )
  }

  /** Serialize steer deliveries per invocation: one pane write at a time, FIFO. */
  function withSteerLock<T>(inv: Invocation, work: () => Promise<T>): Promise<T> {
    const previous = inv.steerPromise ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(work)
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    inv.steerPromise = tail
    return run.finally(() => {
      if (inv.steerPromise === tail) inv.steerPromise = undefined
    })
  }

  /**
   * Legacy invocation.input busy steer: one attempt, reported immediately.
   * The broker-held retries of submission.steer do not apply here.
   */
  async function attemptSteerAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<InvocationInputResponse> {
    if (inv.driver.applySteerNow === undefined) {
      // Reachable from the public steer RPC: admission.classes is a driver
      // DECLARATION and is not cross-checked against applySteerNow presence
      // (only input.busyPolicies is), so a driver can admit a steer it cannot
      // execute. Record the evidence so the admitted-execution rejection stays
      // a truthful TERMINAL refusal instead of defaulting to possibly-written
      // and leaving a submission that never reached a driver undisposed.
      const refused = inv.submissions.get(input.inputId)
      if (refused !== undefined) refused.deliveryEvidence = 'not_written'
      return rejectQueueInput(inv, input.inputId, REASON_STEER_NOT_SUPPORTED, 'not_written')
    }
    return withSteerLock(inv, async () => {
      const progress = { possiblyWritten: false }
      for (;;) {
        const attempt = await attemptSteerOnce(inv, input, progress, false)
        if (attempt.kind === 'again') continue
        if (attempt.kind === 'delivered') {
          return attempt.started !== undefined
            ? {
                inputId: input.inputId,
                accepted: true,
                disposition: 'started',
                turnId: attempt.started.turnId,
              }
            : { inputId: input.inputId, accepted: true, disposition: 'attempted_steer' }
        }
        const failure =
          attempt.kind === 'final'
            ? attempt
            : {
                error: new TmuxPaneNotQuiescentError('before_paste'),
                evidence: 'not_written' as const,
              }
        const failed = inv.submissions.get(input.inputId)
        if (failed !== undefined) failed.deliveryEvidence = failure.evidence
        return rejectQueueInput(
          inv,
          input.inputId,
          String(failure.error instanceof Error ? failure.error.message : failure.error),
          failure.evidence
        )
      }
    })
  }

  /**
   * Deliver an admitted submission.steer (agent-spaces.broker-steer-one-door).
   * The admission reply has already gone out; from here the broker holds the
   * steer while the invocation is starting, a guarded turn runs or a prompt is
   * open, retries a pane that refused before paste, and then starts a turn
   * (idle) or injects into the live one (busy). Holds and retries are silent:
   * only the final attempt is reported, and the steer reaches one terminal.
   */
  function deliverSteer(inv: Invocation, record: SubmissionRecord): Promise<void> {
    // Held from admission, so a steer still queued behind an earlier one is
    // cancelled, not lost, if the invocation ends first.
    inv.heldSteers ??= new Set()
    const held = inv.heldSteers
    held.add(record)
    return withSteerLock(inv, async () => {
      const progress = { possiblyWritten: false }
      try {
        for (;;) {
          if (record.terminal) return
          if (!progress.possiblyWritten) held.add(record)
          const open = await waitForSteerGate(inv)
          if (record.terminal) return
          if (!open) {
            finishSteer(inv, record, closedWhileHeld(), progress.possiblyWritten)
            return
          }
          held.delete(record)
          const attempt = await attemptSteerOnce(inv, record.input, progress, true)
          if (attempt.kind === 'delivered') return
          if (attempt.kind === 'final') {
            // Teardown may already have settled it while the attempt waited.
            if (!record.terminal) {
              rejectAdmittedExecution(inv, record, attempt.error, {
                deliveryEvidence: attempt.evidence,
              })
            }
            return
          }
          if (attempt.kind === 'retry') {
            if (!progress.possiblyWritten) held.add(record)
            if (!(await waitForSteerRetry(inv))) {
              if (!record.terminal) {
                finishSteer(inv, record, closedWhileHeld(), progress.possiblyWritten)
              }
              return
            }
          }
        }
      } finally {
        held.delete(record)
      }
    })
  }

  function closedWhileHeld(): BrokerError {
    return new BrokerError(
      BrokerErrorCode.InvalidInvocationState,
      'Invocation closed while the broker held the steer'
    )
  }

  function finishSteer(
    inv: Invocation,
    record: SubmissionRecord,
    error: unknown,
    possiblyWritten: boolean
  ): void {
    rejectAdmittedExecution(inv, record, error, {
      deliveryEvidence: possiblyWritten ? 'possibly_written' : 'not_written',
    })
  }

  /**
   * One steer attempt through whichever path the seat's current state calls
   * for. `allowIdleStart` lets an idle seat start the steer's own turn; the
   * legacy busy path never does.
   */
  async function attemptSteerOnce(
    inv: Invocation,
    input: InvocationInputWithId,
    progress: { possiblyWritten: boolean },
    allowIdleStart: boolean
  ): Promise<SteerAttempt> {
    const idle =
      allowIdleStart &&
      inv.state === 'ready' &&
      inv.pendingOwnTurnSubmissionId === undefined &&
      inv.driver.resolvesSteerAtActuation !== true &&
      inv.driver.steerNeverStartsTurn !== true
    if (idle) return startSteerTurn(inv, input)
    if (inv.driver.applySteerNow === undefined) {
      return {
        kind: 'final',
        error: new Error(REASON_STEER_NOT_SUPPORTED),
        evidence: 'not_written',
      }
    }
    try {
      await inv.driver.applySteerNow(input)
    } catch (err) {
      if (paneNotReadyBeforePaste(err)) return { kind: 'retry' }
      let failure = err
      if (steerRequiresOwnTurnOf(err)) {
        if (deliveryEvidenceOf(err) !== 'not_written') progress.possiblyWritten = true
        // T-13687 C: another submission holds the own-turn slot and the
        // harness has no turn yet. A steer is never refused busy and never
        // starts a second own turn: it waits for that turn to start (or the
        // slot to release), then goes back through the gate, since the turn
        // that starts may be guarded.
        if (ownTurnSlotHeldByOther(inv, input.inputId)) {
          if (await waitForPendingWindowChange(inv)) return { kind: 'again' }
          failure = withDeliveryEvidence(
            new BrokerError(
              BrokerErrorCode.InvalidInvocationState,
              'Invocation closed while the steer waited for the pending turn to start'
            ),
            progress.possiblyWritten ? 'possibly_written' : 'not_written'
          )
        } else {
          return startSteerTurn(inv, input)
        }
      }
      // The driver says what its failure proves about the body. A refusal
      // raised before the first paste is a real no-write; everything from the
      // paste onward may have landed.
      return {
        kind: 'final',
        error: failure,
        evidence: deliveryEvidenceOf(failure) ?? 'possibly_written',
      }
    }
    emit(
      inv,
      'input.accepted',
      { inputId: input.inputId, disposition: 'attempted_steer' },
      { inputId: input.inputId }
    )
    return { kind: 'delivered' }
  }

  /** Start the steer's own turn: an idle seat, or a driver's own-turn fallback. */
  async function startSteerTurn(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<SteerAttempt> {
    try {
      const result = await applyAndEmit(inv, input)
      return { kind: 'delivered', started: { turnId: result.turnId } }
    } catch (error) {
      if (paneNotReadyBeforePaste(error)) return { kind: 'retry' }
      return { kind: 'final', error, evidence: deliveryEvidenceOf(error) ?? 'possibly_written' }
    }
  }

  function ownTurnSlotHeldByOther(inv: Invocation, inputId: InputId): boolean {
    return (
      inv.pendingOwnTurnSubmissionId !== undefined && inv.pendingOwnTurnSubmissionId !== inputId
    )
  }

  function invocationClosed(inv: Invocation): boolean {
    return inv.terminalEmitted || (inv.state !== 'ready' && inv.state !== 'turn_active')
  }

  function steerClosed(inv: Invocation): boolean {
    return inv.terminalEmitted || STEER_CLOSED_STATES.has(inv.state)
  }

  /** An open prompt a pasted steer would answer: a permission request or an ask tool. */
  function promptOpen(inv: Invocation): boolean {
    if (inv.pendingPermissions.size > 0) return true
    if ((inv.openPermissionRequests?.size ?? 0) > 0) return true
    for (const call of inv.startedToolCalls.values()) {
      if (ASK_TOOL_NAMES.has(call.name)) return true
    }
    return false
  }

  /** Whether a held steer may be attempted now. */
  function steerGateOpen(inv: Invocation): boolean {
    if (inv.state === 'starting' || inv.startSettled !== true) return false
    if (promptOpen(inv)) return false
    if (pasteWouldMergeIntoPendingTurn(inv)) return false
    return !(inv.state === 'turn_active' && inv.currentTurnPolicy === 'guarded')
  }

  /**
   * A paste driver (harness-evidence brackets: both Claude drivers) with another
   * submission's own-turn delivery handed over and no harness turn running yet:
   * that body may still sit in the composer, so a pasted steer would merge into
   * it and lose its own identity. The steer waits for that turn to start (or the
   * slot to change), then injects (T-13689, mable ruling EN-57033). Hosts that
   * own the window themselves, such as arris-resident, keep injecting at once.
   */
  function pasteWouldMergeIntoPendingTurn(inv: Invocation): boolean {
    return (
      inv.driver.bracketMintingMode === 'harness-evidence' &&
      inv.state === 'ready' &&
      inv.pendingOwnTurnSubmissionId !== undefined
    )
  }

  /** Register a change-driven watcher until `settle` returns a verdict. */
  function watchSteerState(
    inv: Invocation,
    settle: (event: { type: string }) => boolean | undefined,
    timeoutMs?: number
  ): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      inv.steerWatchers ??= new Set()
      const watchers = inv.steerWatchers
      let timer: ReturnType<typeof setTimeout> | undefined
      const finish = (outcome: boolean): void => {
        watchers.delete(watcher)
        if (timer !== undefined) clearTimeout(timer)
        resolve(outcome)
      }
      const watcher = (event: { type: string }): void => {
        const outcome = settle(event)
        if (outcome !== undefined) finish(outcome)
      }
      watchers.add(watcher)
      if (timeoutMs !== undefined) timer = setTimeout(() => finish(true), timeoutMs)
    })
  }

  /** Resolve true once the steer gate opens, false once the invocation closes. */
  function waitForSteerGate(inv: Invocation): Promise<boolean> {
    if (steerClosed(inv)) return Promise.resolve(false)
    if (steerGateOpen(inv)) return Promise.resolve(true)
    return watchSteerState(inv, () =>
      steerClosed(inv) ? false : steerGateOpen(inv) ? true : undefined
    )
  }

  /** Wait out one pane retry interval; false if the invocation closes first. */
  function waitForSteerRetry(inv: Invocation): Promise<boolean> {
    if (steerClosed(inv)) return Promise.resolve(false)
    return watchSteerState(inv, () => (steerClosed(inv) ? false : undefined), steerRetryIntervalMs)
  }

  /** Tell held steers that start() settled; no event marks that moment. */
  function releaseStartHeldSteers(inv: Invocation): void {
    inv.startSettled = true
    for (const watcher of [...(inv.steerWatchers ?? [])]) watcher({ type: 'broker.start.settled' })
  }

  /**
   * Resolve true at the next turn start or own-turn slot change, false once
   * the invocation stops accepting input. Change-driven: never a timer, and a
   * turn already active when the wait begins does not satisfy it.
   */
  function waitForPendingWindowChange(inv: Invocation): Promise<boolean> {
    if (invocationClosed(inv)) return Promise.resolve(false)
    const held = inv.pendingOwnTurnSubmissionId
    return watchSteerState(inv, (event) => {
      if (invocationClosed(inv)) return false
      if (event.type === 'turn.started' || inv.pendingOwnTurnSubmissionId !== held) return true
      return undefined
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

  // ---------------------------------------------------------------------------
  // Queue eviction — reject all pending when invocation terminates or stops
  // ---------------------------------------------------------------------------
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

  // ---------------------------------------------------------------------------
  // InputId resolution
  // ---------------------------------------------------------------------------
  function resolveInputId(inv: Invocation, input: InvocationInput): InputId {
    if (input.inputId) return input.inputId
    inv.inputCounter += 1
    return `input_${inv.invocationId}_${inv.inputCounter}` as InputId
  }

  /**
   * Stable fingerprint of an input request's content + policy, used to detect
   * whether a duplicate inputId carries byte-identical payload (idempotent
   * replay) or differing payload (conflict). Keyed externally by inputId, so
   * the fingerprint deliberately ignores the inputId itself.
   */
  function fingerprintInput(req: InvocationInputRequest): string {
    return stableJsonStringify({
      kind: req.input.kind,
      content: req.input.content,
      policy: req.policy ?? null,
      responseFormat: normalizeResponseFormat(req.input.responseFormat),
    })
  }

  /** Persist a resolved disposition for a client-provided inputId (idempotency). */
  function recordDisposition(
    inv: Invocation,
    req: InvocationInputRequest,
    response: InvocationInputResponse
  ): void {
    if (req.input.inputId === undefined) return
    inv.inputDispositions.set(req.input.inputId, {
      fingerprint: fingerprintInput(req),
      response,
    })
  }

  return {
    admitOnce,
    registerLegacySubmission,
    rejectSubmission,
    checkAdmission,
    admitSubmission,
    rejectAdmittedExecution,
    queueEntry,
    withdrawHeldSubmission,
    holdSubmission,
    hasDriverOwnedAdmissionFence,
    scheduleAdmissionDrain,
    requestPreemptInterrupt,
    maybeRequestPreemptInterrupt,
    scheduleDrain,
    applyAndEmit,
    attemptSteerAndEmit,
    deliverSteer,
    steerRoutesThroughQueue,
    releaseStartHeldSteers,
    rejectQueueInput,
    evictQueue,
    settleUndisposedSubmissions,
    resolveInputId,
    fingerprintInput,
    recordDisposition,
  }
}
