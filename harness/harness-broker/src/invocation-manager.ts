import { join as joinPath } from 'node:path'
import type {
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
  CaptureStateView,
  CaptureWarningPayload,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationCaptureReleaseRequest,
  InvocationCaptureReleaseResponse,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventPayloadMap,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInspectionSummary,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationStartResponse,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  SubmissionClass,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CAPTURE_RELEASE_NOT_BLOCKED,
  LEGACY_BUSY_POLICIES,
  acceptedLifecyclePolicy,
} from 'spaces-harness-broker-protocol'
import { createCaptureGate } from './capture/capture-gate'
import { type CaptureIndex, openCaptureIndex } from './capture/capture-index'
import { createRawJournal } from './capture/raw-journal'
import type { Driver, DriverContext } from './drivers/driver'
import { BrokerError } from './errors'
import { createInvocationAdmission } from './invocation-admission'
import {
  DEFAULT_MAX_INPUT_QUEUE_DEPTH,
  REASON_UNSUPPORTED_FINAL_RESPONSE,
  TERMINAL_STATES,
  assertLifecyclePolicySupported,
  requestsJsonSchemaResponse,
  supportsJsonSchemaResponse,
} from './invocation-constants'
import { createInvocationEvents } from './invocation-events'
import { buildInspectionSummary } from './invocation-inspection'
import type {
  EmitFn,
  InspectionSummaryOptions,
  Invocation,
  InvocationInputWithId,
  InvocationManager,
  InvocationManagerOptions,
} from './invocation-model'
import { createInvocationPermissions } from './invocation-permissions'
import { createInvocationSubmissions } from './invocation-submissions'
import { LEDGER_APPEND_FAILED } from './ledger-commit'
import type { DispatchEnv } from './runtime/env'

export type {
  InspectionSummaryOptions,
  Invocation,
  InvocationManager,
  InvocationManagerOptions,
} from './invocation-model'

export function createInvocationManager(options: InvocationManagerOptions): InvocationManager {
  const { sequencer, onEvent, getClientCapabilities = () => ({}), onPermissionRequest } = options
  const now = options.now ?? (() => new Date())
  const maxQueueDepth = options.maxInputQueueDepth ?? DEFAULT_MAX_INPUT_QUEUE_DEPTH
  const invocations = new Map<string, Invocation>()
  // One index handle per broker process, shared by every invocation's gate.
  // It is the Phase 1a `ledger-index.db` when a ledger dir is configured, and
  // an in-memory index otherwise.
  let captureIndex: CaptureIndex | undefined
  function requireCaptureIndex(): CaptureIndex {
    captureIndex ??= openCaptureIndex(
      options.captureDir !== undefined
        ? joinPath(options.captureDir, 'ledger-index.db')
        : undefined,
      now
    )
    return captureIndex
  }

  const authorizeSubmission = options.authorizeSubmission ?? (() => true)
  const isOperator =
    options.isOperator ??
    ((principalRef: string) => principalRef === 'lance' || principalRef.startsWith('human:'))
  const authorizeQueueJump =
    options.authorizeQueueJump ??
    ((context: { principalRef: string }) => isOperator(context.principalRef))

  function requireInvocation(invocationId: InvocationId): Invocation {
    const inv = invocations.get(invocationId)
    if (!inv) {
      throw new BrokerError(
        BrokerErrorCode.UnknownInvocation,
        `Unknown invocation: ${invocationId}`,
        { invocationId }
      )
    }
    return inv
  }

  // Admission and emission are mutually recursive (a drain emits; a turn
  // terminal drains), so admission binds emit late through this forwarder.
  const emit: EmitFn = (inv, type, payload, extra) => events.emit(inv, type, payload, extra)
  const admission = createInvocationAdmission({ emit, now, invocations, authorizeSubmission })
  const events = createInvocationEvents({ sequencer, onEvent, admission })
  const { brokerProvenance, emitEvent, emitTerminal } = events
  const {
    registerLegacySubmission,
    admitSubmission,
    holdSubmission,
    scheduleAdmissionDrain,
    applyAndEmit,
    rejectAdmittedExecution,
    resolveInputId,
  } = admission
  const { brokerRequestPermission, permissionRespond } = createInvocationPermissions({
    emit,
    now,
    onPermissionRequest,
  })
  const submissions = createInvocationSubmissions({
    admission,
    emit,
    requireInvocation,
    maxQueueDepth,
    isOperator,
    authorizeQueueJump,
  })

  return {
    ...submissions,

    async start(
      spec: HarnessInvocationSpec,
      driver: Driver,
      initialInput?: InvocationInput | undefined,
      dispatchEnv?: DispatchEnv | undefined,
      runtime?: InvocationRuntimeContext | undefined,
      lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
    ): Promise<InvocationStartResponse> {
      // Check if there's already an active invocation
      for (const existing of invocations.values()) {
        if (!TERMINAL_STATES.has(existing.state) && existing.state !== 'disposed') {
          throw new BrokerError(
            BrokerErrorCode.InvalidInvocationState,
            'A non-terminal invocation already exists; single-invocation broker rejects concurrent starts',
            { existingInvocationId: existing.invocationId }
          )
        }
      }

      const invocationId =
        spec.invocationId ??
        (`inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}` as InvocationId)

      const driverCaps = driver.capabilities(spec)
      assertLifecyclePolicySupported(lifecyclePolicy, driverCaps)
      // T-03779: reject a JSON Schema initialInput on an unsupporting driver
      // BEFORE driver.start and before the invocation is registered, so no
      // input.accepted/input.rejected is emitted and the driver never sees it.
      if (
        initialInput !== undefined &&
        requestsJsonSchemaResponse(initialInput) &&
        !supportsJsonSchemaResponse(driverCaps)
      ) {
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          REASON_UNSUPPORTED_FINAL_RESPONSE
        )
      }
      const composedQueue =
        driverCaps.input.queue === true &&
        // input.user is a capability-dependency check (queueing requires user-input capability),
        // NOT a second queue flag.
        driverCaps.input.user === true &&
        spec.interaction?.inputQueue === 'fifo'
      const capabilities: InvocationCapabilities = {
        ...driverCaps,
        admission: {
          // Admission is a driver declaration, not an inference from method
          // presence. A driver may retain a legacy input method without being
          // able to provide the evidence required by a v0.3 admission class.
          classes: [...driverCaps.admission.classes],
        },
        bracketMintingMode: driver.bracketMintingMode,
        queue: { cancelHarnessLocal: false },
        preempt: { mode: driver.preemptMode },
        steer: { landingEvidence: driver.steerLandingEvidence },
        interrupt: { landingEvidence: driver.interruptLandingEvidence },
        input: {
          ...driverCaps.input,
          // Broker-composed: the public surface reflects the composed value,
          // NOT the raw driver-reported value.
          queue: composedQueue,
          // T-07155: advertise what THIS broker process can execute. Clients
          // negotiate against this instead of assuming an installed upgrade
          // reached a long-lived broker; `steer` appears iff the driver can
          // actually write into the active turn.
          busyPolicies: [
            ...LEGACY_BUSY_POLICIES,
            ...(driver.applySteerNow !== undefined ? (['steer'] as const) : []),
          ],
        },
      }

      // Two-step because the capture gate's emit callbacks close over `inv`:
      // the record exists first, then its normalization cursor is attached.
      const inv = {
        invocationId,
        spec,
        state: 'starting',
        capabilities,
        driver,
        terminalEmitted: false,
        disposedEmitted: false,
        pending: [],
        brokerQueue: [],
        submissions: new Map(),
        submissionDispositions: new Map(),
        turnManifests: new Map(),
        currentTurnPolicy: 'open',
        currentTurnRequestInFlight: false,
        submissionCounter: 0,
        inputCounter: 0,
        inputDispositions: new Map(),
        startedTurns: new Map(),
        terminalTurns: new Map(),
        startedToolCalls: new Map(),
        pendingPermissions: new Map(),
        settledPermissions: new Map(),
      } as unknown as Invocation
      inv.capture = createCaptureGate({
        invocationId,
        journal: createRawJournal({
          invocationId,
          ...(options.captureDir !== undefined ? { dir: options.captureDir } : {}),
          now,
        }),
        index: requireCaptureIndex(),
        normalizer: { name: driver.kind, version: driver.version },
        now,
        ...(options.logWarn !== undefined ? { warn: options.logWarn } : {}),
        // The gate's own events are BROKER facts about capture, never provider
        // observations — so they carry broker provenance explicitly rather than
        // inheriting the `diagnostic` family's declared authority from the
        // driver tag. Without this a driver whose diagnostics come from hooks
        // would publish `capture.warning` as hook-observed, which it never is.
        emitWarning: (payload: CaptureWarningPayload) =>
          emit(inv, 'capture.warning', payload, {
            driver: { kind: driver.kind },
            provenance: brokerProvenance,
          }).seq,
      })
      invocations.set(invocationId, inv)

      const ctx: DriverContext = {
        invocationId,
        clientCapabilities: getClientCapabilities(),
        ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        capture: inv.capture,
        ...(options.captureDir !== undefined ? { durableStateDir: options.captureDir } : {}),
        emit<K extends InvocationEventType>(
          type: K,
          payload: InvocationEventPayloadMap[K],
          extra?: Parameters<typeof emit>[3]
        ) {
          return emit(inv, type, payload, extra)
        },
        emitEvent: (event, extra) => emitEvent(inv, event, extra),
        admissionStateChanged: () => scheduleAdmissionDrain(inv),
        ...(onPermissionRequest !== undefined
          ? {
              // Broker-owned permission lifecycle (C2): the driver hands the
              // request to the broker, which holds it until an absolute
              // deadline, survives controller disconnect, emits
              // permission.resolved, and returns the final decision.
              requestPermission: (params) => brokerRequestPermission(inv, params),
              brokerOwnsPermissionLifecycle: true,
            }
          : {}),
      }

      if (lifecyclePolicy !== undefined) {
        // Retain the FULL accepted overlay on the record so the inspection
        // lifecycle view can report idle-ttl details without reconstructing them
        // from the accepted-policy event (which only carries the modes).
        inv.lifecycleOverlay = lifecyclePolicy
        emit(inv, 'lifecycle.policy.accepted', acceptedLifecyclePolicy(lifecyclePolicy))
      }

      try {
        await driver.start(spec, ctx)
      } catch (err) {
        inv.state = 'failed'
        emitTerminal(inv, 'invocation.failed', {
          message: err instanceof Error ? err.message : 'Driver start failed',
        })
        throw err
      }

      if (!inv.terminalEmitted) {
        // Synthetic invocation.started is a fallback for drivers that do not emit
        // their own harness.started; skip it when a real harness.started arrived.
        if (inv.state === 'starting' && inv.harnessStartedSeen !== true) {
          emit(inv, 'invocation.started', {
            command:
              spec.process.execution === 'native-worker' ? process.execPath : spec.process.command,
            args: spec.process.execution === 'native-worker' ? [] : spec.process.args,
            cwd: spec.process.cwd,
          })
        }
        if (inv.state === 'starting') {
          emit(inv, 'invocation.ready', { state: 'ready' })
        }
      }

      if (inv.state !== 'turn_active') inv.state = 'ready'

      // Apply initialInput through the same broker-owned path as client.input()
      if (initialInput !== undefined && !inv.terminalEmitted) {
        const inputId = resolveInputId(inv, initialInput)
        const inputWithId: InvocationInputWithId = { ...initialInput, inputId }
        const launchClass: SubmissionClass = capabilities.admission.classes.includes('exclusive')
          ? 'exclusive'
          : 'queue'
        const submission = registerLegacySubmission(inv, launchClass, inputWithId)
        admitSubmission(inv, submission)
        if (launchClass === 'queue') {
          holdSubmission(inv, submission, 'queue')
          scheduleAdmissionDrain(inv)
        } else {
          try {
            await applyAndEmit(inv, inputWithId)
          } catch (error) {
            rejectAdmittedExecution(inv, submission, error)
            throw error
          }
        }
      }

      return {
        invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
        ...(lifecyclePolicy !== undefined
          ? { acceptedLifecyclePolicy: acceptedLifecyclePolicy(lifecyclePolicy) }
          : {}),
      }
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const inv = requireInvocation(req.invocationId)
      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, effect: 'no_active_turn', reason: `Invocation is ${inv.state}` }
      }
      const turnId = inv.currentTurnId
      emit(inv, 'interrupt.requested', {
        ...(turnId !== undefined ? { turnId } : {}),
      })
      try {
        const response = await inv.driver.interrupt(req)
        if (response.accepted) {
          emit(inv, 'interrupt.landed', {
            ...(turnId !== undefined ? { turnId } : {}),
          })
        } else {
          emit(inv, 'interrupt.failed', {
            ...(turnId !== undefined ? { turnId } : {}),
            reason: response.reason ?? response.effect,
          })
        }
        return response
      } catch (error) {
        emit(inv, 'interrupt.failed', {
          ...(turnId !== undefined ? { turnId } : {}),
          reason: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
    },

    async stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
      const inv = requireInvocation(req.invocationId)

      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, state: inv.state }
      }

      inv.state = 'stopping'
      emit(inv, 'invocation.stopping', { reason: req.reason })

      const result = await inv.driver.stop(req)

      // Terminal state determined by driver
      const terminalState = result.state === 'failed' ? 'failed' : 'exited'
      inv.state = terminalState

      if (terminalState === 'failed') {
        emitTerminal(inv, 'invocation.failed', {
          message: req.reason ?? 'Stopped',
        })
      } else {
        emitTerminal(inv, 'invocation.exited', {})
      }

      return { accepted: true, state: inv.state }
    },

    status(invocationId: InvocationId, opts?: InspectionSummaryOptions): InvocationStatusResponse {
      const inv = requireInvocation(invocationId)
      // status() projects through the shared inspection summary, then layers the
      // status-only fields (capabilities/continuation/process + legacy ids).
      const response: InvocationStatusResponse = {
        ...buildInspectionSummary(inv, opts),
        capabilities: inv.capabilities,
        continuation: inv.continuation,
      }
      if (inv.currentTurnId !== undefined) {
        response.currentTurnId = inv.currentTurnId
      }
      if (inv.currentHarnessGeneration !== undefined) {
        response.currentHarnessGeneration = inv.currentHarnessGeneration
      }
      if (inv.currentTurnAttempt !== undefined) {
        response.currentTurnAttempt = inv.currentTurnAttempt
      }
      // Project child-process info when any of pid/exitCode/signal is known.
      if (inv.childPid !== undefined || inv.exitCode !== undefined || inv.signal !== undefined) {
        response.process = {
          ...(inv.childPid !== undefined ? { pid: inv.childPid } : {}),
          ...(inv.exitCode !== undefined ? { exitCode: inv.exitCode } : {}),
          ...(inv.signal !== undefined ? { signal: inv.signal } : {}),
        }
      }
      return response
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      const inv = requireInvocation(req.invocationId)

      // Idempotent: a second dispose neither re-runs the driver nor re-emits.
      if (inv.state === 'disposed' || inv.disposedEmitted) {
        return { disposed: true }
      }

      if (!TERMINAL_STATES.has(inv.state)) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot dispose invocation in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      await inv.driver.dispose()

      // emit() → applyEventState sets state = 'disposed' and disposedEmitted.
      emit(inv, 'invocation.disposed', { disposed: true })

      return { disposed: true }
    },

    failForStorage(invocationId: InvocationId, detail: string): void {
      const inv = invocations.get(invocationId)
      if (inv === undefined || inv.state === 'disposed') {
        return
      }
      const wasTerminal = TERMINAL_STATES.has(inv.state)
      if (!wasTerminal) {
        inv.state = 'failed'
      }
      emitTerminal(inv, 'invocation.failed', {
        message: `Event ledger append failed: ${detail}`,
        reason: LEDGER_APPEND_FAILED,
        code: 'LEDGER_APPEND_FAILED',
        retryable: false,
        data: { detail },
      })
      // Best effort and out of band: the caller is inside the publish path, so
      // this must neither block it nor let a driver rejection escape into it.
      void (async () => {
        try {
          await inv.driver.stop({ invocationId, reason: LEDGER_APPEND_FAILED })
        } catch {
          // The driver is being torn down because storage is already broken;
          // a stop failure changes nothing we can still record.
        }
        try {
          await inv.driver.dispose()
        } catch {
          // Same: dispose is the last cleanup step, with nowhere left to report.
        }
      })()
    },

    captureRelease(req: InvocationCaptureReleaseRequest): InvocationCaptureReleaseResponse {
      const inv = requireInvocation(req.invocationId)
      // Since T-07883 the cursor never blocks. Keep the public refusal and
      // report current state for both known and unknown record IDs.
      throw new BrokerError(
        -32602 as BrokerErrorCode,
        `Raw record ${req.rawRecordId} is not the blocked-unknown record for ${req.invocationId}`,
        {
          reason: CAPTURE_RELEASE_NOT_BLOCKED,
          invocationId: req.invocationId,
          rawRecordId: req.rawRecordId,
          capture: inv.capture.state(),
        }
      )
    },

    captureState(invocationId: InvocationId): CaptureStateView | undefined {
      return invocations.get(invocationId)?.capture.state()
    },

    replayPendingCapture(invocationId: InvocationId): number {
      const inv = invocations.get(invocationId)
      if (inv === undefined) return 0
      const normalize = inv.driver.captureNormalizer?.()
      if (normalize === undefined) return 0
      return inv.capture.replayPending(normalize)
    },

    permissionRespond(
      req: InvocationPermissionRespondRequest
    ): InvocationPermissionRespondResponse {
      return permissionRespond(requireInvocation(req.invocationId), req)
    },

    get(invocationId: InvocationId): Invocation | undefined {
      return invocations.get(invocationId)
    },

    buildInspectionSummary(
      invocationId: InvocationId,
      opts?: InspectionSummaryOptions
    ): InvocationInspectionSummary {
      return buildInspectionSummary(requireInvocation(invocationId), opts)
    },

    listInvocations(req: BrokerListInvocationsRequest): BrokerListInvocationsResponse {
      const includeDisposed = req.includeDisposed === true
      const opts: InspectionSummaryOptions = {
        ...(req.probeLiveness !== undefined ? { probeLiveness: req.probeLiveness } : {}),
      }
      const invocationsOut: InvocationInspectionSummary[] = []
      for (const inv of invocations.values()) {
        if (inv.state === 'disposed' && !includeDisposed) continue
        invocationsOut.push(buildInspectionSummary(inv, opts))
      }
      return { invocations: invocationsOut }
    },

    activeCount(): number {
      let count = 0
      for (const inv of invocations.values()) {
        if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
          count++
        }
      }
      return count
    },
  }
}
