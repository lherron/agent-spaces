import type {
  AdmissionLayer,
  InputId,
  InvocationId,
  InvocationInputRequest,
  InvocationInputResponse,
  QueueCancelRequest,
  QueueCancelResponse,
  QueueJumpRequest,
  QueueJumpResponse,
  QueueListResponse,
  SeatProbeResponse,
  SubmissionClass,
  SubmissionEnqueueRequest,
  SubmissionInvokeRequest,
  SubmissionPreemptRequest,
  SubmissionResponse,
  SubmissionSteerRequest,
  SubmissionWithdrawRequest,
  SubmissionWithdrawResponse,
  TurnId,
  TurnManifestResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { ApplyInputResult } from './drivers/driver'
import { BrokerError } from './errors'
import type { InvocationAdmission } from './invocation-admission'
import {
  REASON_BUSY_REJECTED,
  REASON_QUEUE_FULL,
  REASON_QUEUE_NOT_SUPPORTED,
  REASON_STEER_NOT_SUPPORTED,
  REASON_UNSUPPORTED_BUSY_POLICY,
  REASON_UNSUPPORTED_FINAL_RESPONSE,
  REASON_UNSUPPORTED_INPUT_KIND,
  requestsJsonSchemaResponse,
  supportsJsonSchemaResponse,
} from './invocation-constants'
import type {
  EmitFn,
  Invocation,
  InvocationInputWithId,
  InvocationManager,
  InvocationManagerOptions,
} from './invocation-model'

export interface InvocationSubmissionsDeps {
  admission: InvocationAdmission
  emit: EmitFn
  requireInvocation(invocationId: InvocationId): Invocation
  maxQueueDepth: number
  isOperator(principalRef: string): boolean
  authorizeQueueJump: NonNullable<InvocationManagerOptions['authorizeQueueJump']>
}

type InvocationSubmissionMethods = Pick<
  InvocationManager,
  | 'steer'
  | 'enqueue'
  | 'invoke'
  | 'preempt'
  | 'withdraw'
  | 'queueList'
  | 'queueJump'
  | 'queueCancel'
  | 'turnManifest'
  | 'seatProbe'
  | 'input'
>

/** Public submission, queue, and legacy input surface of the invocation manager. */
export function createInvocationSubmissions(
  deps: InvocationSubmissionsDeps
): InvocationSubmissionMethods {
  const { emit, requireInvocation, maxQueueDepth, isOperator, authorizeQueueJump } = deps
  const {
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
    applyAndEmit,
    attemptSteerAndEmit,
    rejectQueueInput,
    resolveInputId,
    fingerprintInput,
    recordDisposition,
  } = deps.admission

  return {
    async steer(req: SubmissionSteerRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'steer', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      const response = admitSubmission(inv, record)
      if (
        inv.state === 'ready' &&
        inv.pendingOwnTurnSubmissionId === undefined &&
        inv.driver.resolvesSteerAtActuation !== true &&
        inv.driver.steerNeverStartsTurn !== true
      ) {
        void applyAndEmit(inv, record.input).catch((error) =>
          rejectAdmittedExecution(inv, record, error)
        )
      } else {
        void attemptSteerAndEmit(inv, record.input).then((result) => {
          if (!result.accepted) {
            rejectAdmittedExecution(inv, record, result.reason ?? 'steer-failed', {
              deliveryEvidence: record.deliveryEvidence,
              inputRejectedEmitted: true,
            })
          }
        })
      }
      return response
    },

    async enqueue(req: SubmissionEnqueueRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'queue', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      if (inv.brokerQueue.length >= maxQueueDepth) {
        return rejectSubmission(inv, record, 'state', REASON_QUEUE_FULL)
      }
      const response = admitSubmission(inv, record)
      holdSubmission(inv, record, 'queue', req.ttlMs)
      scheduleAdmissionDrain(inv)
      return response
    },

    async invoke(req: SubmissionInvokeRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'exclusive', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      if (inv.state === 'turn_active' || inv.pendingOwnTurnSubmissionId !== undefined) {
        return rejectSubmission(inv, record, 'state', 'busy')
      }
      const response = admitSubmission(inv, record)
      void applyAndEmit(inv, record.input).catch((error) =>
        rejectAdmittedExecution(inv, record, error)
      )
      return response
    },

    async preempt(req: SubmissionPreemptRequest): Promise<SubmissionResponse> {
      const inv = requireInvocation(req.invocationId)
      const record = registerSubmission(inv, 'preempt', req)
      const rejection = await checkAdmission(inv, record, req)
      if (rejection !== undefined) return rejection
      const response = admitSubmission(inv, record)
      holdSubmission(inv, record, 'preempt', req.ttlMs)
      if (inv.state === 'turn_active') {
        if (inv.driver.preemptMode === 'quiescence') maybeRequestPreemptInterrupt(inv)
        else void requestPreemptInterrupt(inv, record)
      } else scheduleAdmissionDrain(inv)
      return response
    },

    withdraw(req: SubmissionWithdrawRequest): Promise<SubmissionWithdrawResponse> {
      return withdrawHeldSubmission(req)
    },

    queueList(invocationId: InvocationId): QueueListResponse {
      const inv = requireInvocation(invocationId)
      return { entries: inv.brokerQueue.map(queueEntry) }
    },

    async queueJump(req: QueueJumpRequest): Promise<QueueJumpResponse> {
      const inv = requireInvocation(req.invocationId)
      const fromPosition = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === req.submissionId
      )
      if (fromPosition < 0) return { jumped: false, reason: 'not-broker-held' }
      const queued = inv.brokerQueue[fromPosition]
      if (queued === undefined) return { jumped: false, reason: 'not-broker-held' }
      const toPosition = Math.max(0, Math.min(req.position, inv.brokerQueue.length - 1))
      const authorized = await authorizeQueueJump({
        invocationId: inv.invocationId,
        principalRef: req.principalRef,
        submissionOrigin: queued.record.origin,
        fromPosition,
        toPosition,
      })
      if (!authorized) return { jumped: false, reason: 'authority-denied' }
      const [item] = inv.brokerQueue.splice(fromPosition, 1)
      if (item === undefined) return { jumped: false, reason: 'not-broker-held' }
      inv.brokerQueue.splice(toPosition, 0, item)
      emit(inv, 'queue.jumped', {
        submissionId: req.submissionId,
        fromPosition,
        toPosition,
        principalRef: req.principalRef,
      })
      scheduleAdmissionDrain(inv)
      return { jumped: true }
    },

    async queueCancel(req: QueueCancelRequest): Promise<QueueCancelResponse> {
      const inv = requireInvocation(req.invocationId)
      const index = inv.brokerQueue.findIndex(
        (item) => item.record.submissionId === req.submissionId
      )
      if (index < 0) {
        const record = inv.submissions.get(req.submissionId)
        if (
          record === undefined ||
          (record.origin.principalRef !== req.principalRef && !isOperator(req.principalRef))
        ) {
          return {
            cancelled: false,
            reason: record === undefined ? 'not-broker-held' : 'authority-denied',
          }
        }
        const result = await inv.driver.cancelInput?.(
          record.submissionId as InputId,
          'queue.cancel'
        )
        if (result?.outcome !== 'cancelled') {
          return { cancelled: false, reason: result?.outcome ?? 'not-broker-held' }
        }
        emit(inv, 'submission.cancelled', {
          submissionId: record.submissionId,
          reason: 'broker-cancelled',
        })
        if (inv.pendingOwnTurnSubmissionId === record.submissionId) {
          inv.pendingOwnTurnSubmissionId = undefined
        }
        scheduleAdmissionDrain(inv)
        return { cancelled: true }
      }
      const item = inv.brokerQueue[index]
      if (
        item === undefined ||
        (item.record.origin.principalRef !== req.principalRef && !isOperator(req.principalRef))
      ) {
        return { cancelled: false, reason: 'authority-denied' }
      }
      inv.brokerQueue.splice(index, 1)
      if (item.timer !== undefined) clearTimeout(item.timer)
      emit(inv, 'queue.cancelled', {
        submissionId: req.submissionId,
        principalRef: req.principalRef,
      })
      emit(inv, 'submission.cancelled', {
        submissionId: req.submissionId,
        reason: 'broker-cancelled',
      })
      return { cancelled: true }
    },

    turnManifest(invocationId: InvocationId, turnId: TurnId): TurnManifestResponse {
      const inv = requireInvocation(invocationId)
      const manifest = inv.turnManifests.get(turnId)
      if (manifest === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Turn not attributed: ${turnId}`,
          {
            invocationId,
            turnId,
          }
        )
      }
      return manifest
    },

    seatProbe(invocationId: InvocationId): SeatProbeResponse {
      const inv = requireInvocation(invocationId)
      const stalePending =
        inv.state === 'ready' &&
        inv.pendingOwnTurnSubmissionId !== undefined &&
        inv.pendingOwnTurnContestedByTurnId !== undefined &&
        inv.terminalTurns.has(inv.pendingOwnTurnContestedByTurnId)
      if (stalePending && inv.stalePendingProbeReported !== true) {
        inv.stalePendingProbeReported = true
        emit(inv, 'diagnostic', {
          level: 'error',
          source: 'broker',
          kind: 'seat_probe_stale_pending',
          message: 'Ready seat retained an own-turn submission after a completed turn',
          data: {
            submissionId: inv.pendingOwnTurnSubmissionId,
            contestedByTurnId: inv.pendingOwnTurnContestedByTurnId,
          },
        })
      }
      const seat =
        inv.state === 'ready' && inv.pendingOwnTurnSubmissionId !== undefined && !stalePending
          ? ({ state: 'starting' } as const)
          : inv.state === 'ready'
            ? ({ state: 'idle' } as const)
            : inv.state === 'turn_active' && inv.unattributedTurnId !== undefined
              ? ({ state: 'turn-observed', turnId: inv.unattributedTurnId } as const)
              : inv.state === 'turn_active' && inv.currentTurnId !== undefined
                ? ({
                    state: 'turn-active',
                    turnId: inv.currentTurnId,
                    policy: inv.currentTurnPolicy,
                  } as const)
                : inv.state === 'starting'
                  ? ({ state: 'starting' } as const)
                  : inv.state === 'stopping'
                    ? ({ state: 'stopping' } as const)
                    : ({ state: 'terminal' } as const)
      return { invocationId, seat, brokerHeldDepth: inv.brokerQueue.length }
    },

    async input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      const inv = requireInvocation(req.invocationId)

      // inputId idempotency: a duplicate client-provided inputId replays the
      // original response when content/policy is byte-identical, or conflicts
      // when it differs. Checked before any state validation so a retry never
      // re-drives a turn or trips a stale-state rejection.
      const providedInputId = req.input.inputId
      if (providedInputId !== undefined) {
        const existing = inv.inputDispositions.get(providedInputId)
        if (existing !== undefined) {
          if (existing.fingerprint === fingerprintInput(req)) {
            return existing.response
          }
          throw new BrokerError(
            BrokerErrorCode.DuplicateInputConflict,
            `Duplicate inputId ${providedInputId} differs by content, policy, or responseFormat`,
            { invocationId: inv.invocationId, inputId: providedInputId }
          )
        }
      }

      // Resolve inputId upfront — stable across all paths
      const rawInput = req.input
      const inputId = resolveInputId(inv, rawInput)
      const input: InvocationInputWithId = { ...rawInput, inputId }
      const seatBusy =
        inv.state === 'turn_active' ||
        inv.pendingOwnTurnSubmissionId !== undefined ||
        hasDriverOwnedAdmissionFence(inv)
      const admissionClass: SubmissionClass = seatBusy
        ? req.policy?.whenBusy === 'queue'
          ? 'queue'
          : req.policy?.whenBusy === 'interrupt_then_apply'
            ? 'preempt'
            : req.policy?.whenBusy === 'steer' || input.kind === 'steer'
              ? 'steer'
              : 'exclusive'
        : input.kind === 'steer'
          ? 'steer'
          : 'exclusive'
      const submission = registerLegacySubmission(inv, admissionClass, input)

      const rejectLegacy = (
        layer: AdmissionLayer,
        reason: string,
        code: BrokerErrorCode = BrokerErrorCode.InputRejected
      ): never => {
        rejectSubmission(inv, submission, layer, reason)
        emit(inv, 'input.rejected', { inputId, reason }, { inputId })
        throw new BrokerError(code, reason, { invocationId: inv.invocationId, inputId })
      }
      const rejectLegacyResponse = (
        layer: AdmissionLayer,
        reason: string
      ): InvocationInputResponse => {
        rejectSubmission(inv, submission, layer, reason)
        const response = rejectQueueInput(inv, inputId, reason)
        recordDisposition(inv, req, response)
        return response
      }

      // Invalid state rejection
      if (inv.state !== 'ready' && inv.state !== 'turn_active') {
        rejectLegacy(
          'state',
          `Cannot accept input in state: ${inv.state}`,
          BrokerErrorCode.InvalidInvocationState
        )
      }

      if (input.kind === 'steer' && !inv.capabilities.input.steer) {
        rejectLegacy(
          'capability',
          'UnsupportedCapability: input.steer',
          BrokerErrorCode.UnsupportedCapability
        )
      }
      if (input.kind === 'append_context' && !inv.capabilities.input.appendContext) {
        rejectLegacy(
          'capability',
          'UnsupportedCapability: input.appendContext',
          BrokerErrorCode.UnsupportedCapability
        )
      }
      // T-03779: a JSON Schema response format is accepted only when the driver
      // advertises per-turn structured support. Reject before input.accepted,
      // queueing, or driver apply.
      if (requestsJsonSchemaResponse(input) && !supportsJsonSchemaResponse(inv.capabilities)) {
        rejectLegacy(
          'capability',
          REASON_UNSUPPORTED_FINAL_RESPONSE,
          BrokerErrorCode.UnsupportedCapability
        )
      }

      // --- State: ready → apply immediately ---
      if (
        inv.state === 'ready' &&
        inv.pendingOwnTurnSubmissionId === undefined &&
        !hasDriverOwnedAdmissionFence(inv)
      ) {
        admitSubmission(inv, submission)
        let result: ApplyInputResult
        try {
          result = await applyAndEmit(inv, input)
        } catch (error) {
          rejectAdmittedExecution(inv, submission, error)
          throw error
        }
        const response: InvocationInputResponse = {
          inputId,
          accepted: true,
          disposition: 'started',
          turnId: result.turnId,
        }
        recordDisposition(inv, req, response)
        return response
      }

      // --- State: turn_active → policy-driven ---
      const policy = req.policy

      // Default: no policy → reject (legacy behavior)
      const busyPolicy =
        policy ?? rejectLegacy('state', 'Input rejected: turn already active (no policy specified)')

      if (busyPolicy.whenBusy === 'reject') {
        rejectLegacy('state', REASON_BUSY_REJECTED)
      }
      if (busyPolicy.whenBusy === 'queue') {
        if (input.kind !== 'user') {
          return rejectLegacyResponse('capability', REASON_UNSUPPORTED_INPUT_KIND)
        }
        const queueEnabled =
          inv.spec.interaction?.inputQueue === 'fifo' && inv.capabilities.input.queue === true
        if (!queueEnabled) {
          return rejectLegacyResponse('capability', REASON_QUEUE_NOT_SUPPORTED)
        }
        if (
          inv.spec.interaction?.mode === 'interactive' &&
          inv.driver.applySteerNow !== undefined
        ) {
          admitSubmission(inv, submission)
          const response = await attemptSteerAndEmit(inv, input)
          if (!response.accepted) {
            // attemptSteerAndEmit already classified the failure and emitted
            // input.rejected; reuse that evidence so a not_written refusal
            // stays terminal and a possible write is reported only once.
            rejectAdmittedExecution(
              inv,
              submission,
              response.reason ?? REASON_STEER_NOT_SUPPORTED,
              { deliveryEvidence: submission.deliveryEvidence, inputRejectedEmitted: true }
            )
          }
          recordDisposition(inv, req, response)
          return response
        }
        if (inv.pending.length >= maxQueueDepth) {
          return rejectLegacyResponse('state', REASON_QUEUE_FULL)
        }
        admitSubmission(inv, submission)
        inv.pending.push({ inputId, input })
        emit(inv, 'input.queued', { inputId, disposition: 'queued' }, { inputId })
        const response: InvocationInputResponse = {
          inputId,
          accepted: true,
          disposition: 'queued',
        }
        recordDisposition(inv, req, response)
        return response
      }
      if (busyPolicy.whenBusy === 'interrupt_then_apply') {
        return rejectLegacyResponse('capability', REASON_UNSUPPORTED_BUSY_POLICY)
      }
      if (input.kind !== 'user') {
        return rejectLegacyResponse('capability', REASON_UNSUPPORTED_INPUT_KIND)
      }
      if (inv.driver.applySteerNow === undefined) {
        return rejectLegacyResponse('capability', REASON_STEER_NOT_SUPPORTED)
      }
      if (inv.currentTurnPolicy === 'guarded') {
        return rejectLegacyResponse('policy', 'guarded')
      }
      admitSubmission(inv, submission)
      const response = await attemptSteerAndEmit(inv, input)
      if (!response.accepted) {
        rejectAdmittedExecution(inv, submission, response.reason, {
          deliveryEvidence: submission.deliveryEvidence,
          inputRejectedEmitted: true,
        })
      }
      recordDisposition(inv, req, response)
      return response
    },
  }
}
