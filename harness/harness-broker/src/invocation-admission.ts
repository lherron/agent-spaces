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
import { deliveryEvidenceOf, steerRequiresOwnTurnOf } from './drivers/driver'
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

export interface InvocationAdmissionDeps {
  emit: EmitFn
  now: () => Date
  invocations: Map<string, Invocation>
  authorizeSubmission: NonNullable<InvocationManagerOptions['authorizeSubmission']>
}

export type InvocationAdmission = ReturnType<typeof createInvocationAdmission>

/**
 * Submission admission, broker-held queue, drain, and delivery: everything that
 * decides whether and when an input reaches the driver.
 */
export function createInvocationAdmission(deps: InvocationAdmissionDeps) {
  const { emit, now, invocations, authorizeSubmission } = deps

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

  function registerSubmission(
    inv: Invocation,
    admissionClass: SubmissionClass,
    req: SubmissionRequest
  ): SubmissionRecord {
    const submissionId = nextSubmissionId(inv)
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
    if (!inv.capabilities.admission.classes.includes(record.class)) {
      return rejectSubmission(inv, record, 'capability', `unsupported:${record.class}`)
    }
    const driverRejection = inv.driver.admissionRejectionReason?.(record.class)
    if (driverRejection !== undefined) {
      return rejectSubmission(inv, record, 'capability', driverRejection)
    }
    if (req.freshContext === true) {
      return rejectSubmission(inv, record, 'capability', 'fresh-context-unsupported')
    }
    if (inv.state !== 'ready' && inv.state !== 'turn_active') {
      return rejectSubmission(inv, record, 'state', `invalid-state:${inv.state}`)
    }
    // A steer exists to land mid-turn: to a busy harness (a delivery awaiting
    // its turn, or a turn still unattributed) it is injected immediately, never
    // held or refused (T-08527). Exclusive is not best effort and stays busy.
    if (inv.pendingOwnTurnSubmissionId !== undefined && record.class === 'exclusive') {
      return rejectSubmission(inv, record, 'state', 'busy')
    }
    if (
      record.class === 'steer' &&
      inv.state === 'turn_active' &&
      inv.currentTurnPolicy === 'guarded'
    ) {
      return rejectSubmission(inv, record, 'policy', 'guarded')
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
    if (evidence === 'possibly_written') {
      // No terminal submission.rejected: a late native user row must still be
      // able to report this body consumed. The submission stays undisposed and
      // the attempt is reported once, with its explicit write evidence.
      if (options?.inputRejectedEmitted !== true) {
        emit(
          inv,
          'input.rejected',
          { inputId: record.submissionId as InputId, reason, deliveryEvidence: evidence },
          { inputId: record.submissionId as InputId }
        )
      }
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
      const reason = inv.driver.admissionRejectionReason?.(item.record.class)
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
        !item.record.terminal &&
        inv.driver.admissionRejectionReason?.(item.record.class) !== undefined
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
        throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'Seat delivery is busy', {
          invocationId: inv.invocationId,
          submissionId: inv.pendingOwnTurnSubmissionId,
        })
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

  async function attemptSteerAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<InvocationInputResponse> {
    const applySteerNow = inv.driver.applySteerNow
    if (applySteerNow === undefined) {
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

    // Serialize pane writes only. This does not create a broker-owned pending
    // turn, and it never retroactively upgrades the request to `started`.
    const previous = inv.steerPromise ?? Promise.resolve()
    const run = previous
      .catch(() => undefined)
      .then(async (): Promise<InvocationInputResponse> => {
        try {
          await applySteerNow.call(inv.driver, input)
        } catch (err) {
          let failure = err
          if (steerRequiresOwnTurnOf(err)) {
            try {
              const result = await applyAndEmit(inv, input)
              return {
                inputId: input.inputId,
                accepted: true,
                disposition: 'started',
                turnId: result.turnId,
              }
            } catch (startError) {
              failure = startError
            }
          }
          // The driver says what its failure proves about the body. A refusal
          // raised before the first paste is a real no-write; everything from
          // the paste onward may have landed.
          const evidence = deliveryEvidenceOf(failure) ?? 'possibly_written'
          const failed = inv.submissions.get(input.inputId)
          if (failed !== undefined) failed.deliveryEvidence = evidence
          return rejectQueueInput(
            inv,
            input.inputId,
            String(failure instanceof Error ? failure.message : failure),
            evidence
          )
        }

        emit(
          inv,
          'input.accepted',
          { inputId: input.inputId, disposition: 'attempted_steer' },
          { inputId: input.inputId }
        )
        return {
          inputId: input.inputId,
          accepted: true,
          disposition: 'attempted_steer',
        }
      })
    const tail = run.then(
      () => undefined,
      () => undefined
    )
    inv.steerPromise = tail
    try {
      return await run
    } finally {
      if (inv.steerPromise === tail) {
        inv.steerPromise = undefined
      }
    }
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
      emit(inv, 'submission.cancelled', {
        submissionId: pendingId,
        reason: 'teardown',
      })
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
    registerSubmission,
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
    rejectQueueInput,
    evictQueue,
    resolveInputId,
    fingerprintInput,
    recordDisposition,
  }
}
