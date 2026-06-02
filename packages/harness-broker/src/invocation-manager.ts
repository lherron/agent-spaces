import type {
  BrokerLifecyclePolicyOverlay,
  ClientCapabilities,
  ContinuationUpdate,
  HarnessInvocationSpec,
  InputId,
  InputPolicy,
  InvocationCapabilities,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationStartResponse,
  InvocationState,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestId,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode, acceptedLifecyclePolicy } from 'spaces-harness-broker-protocol'
import type { Driver, DriverContext } from './drivers/driver'
import { BrokerError } from './errors'
import { stableJsonStringify } from './event-ledger'
import type { InvocationEventSequencer } from './events'
import { normalizeEventPayload } from './runtime/event-normalize'

// ---------------------------------------------------------------------------
// Reason-string vocabulary (centralized for spec traceability)
// ---------------------------------------------------------------------------
const REASON_BUSY_REJECTED = 'busy_rejected'
const REASON_QUEUE_FULL = 'queue_full'
const REASON_QUEUE_NOT_SUPPORTED = 'queue_not_supported'
const REASON_UNSUPPORTED_INPUT_KIND = 'unsupported_input_kind_for_queue'
const REASON_UNSUPPORTED_BUSY_POLICY = 'unsupported_busy_policy'
const REASON_INVOCATION_TERMINATED = 'invocation_terminated'
const REASON_INVOCATION_STOPPING = 'invocation_stopping'

const DEFAULT_MAX_INPUT_QUEUE_DEPTH = 64

/** Fallback bound for a broker-owned permission deadline when the policy omits one. */
const DEFAULT_PERMISSION_TIMEOUT_MS = 1000

type PermissionDecidedBy = 'policy' | 'user' | 'api' | 'timeout'

/** Terminal states that allow dispose. */
const TERMINAL_STATES = new Set<InvocationState>(['exited', 'failed'])

function assertLifecyclePolicySupported(
  policy: BrokerLifecyclePolicyOverlay | undefined,
  capabilities: InvocationCapabilities
): void {
  if (policy === undefined) return
  const missing: string[] = []
  if (!capabilities.lifecycle.runtimeRetention.includes(policy.retention.mode)) {
    missing.push(`retention.${policy.retention.mode}`)
  }
  if (!capabilities.lifecycle.harnessRecovery.includes(policy.harnessRecovery.mode)) {
    missing.push(`harnessRecovery.${policy.harnessRecovery.mode}`)
  }
  if (!capabilities.lifecycle.turnRetry.includes(policy.turnRetry.mode)) {
    missing.push(`turnRetry.${policy.turnRetry.mode}`)
  }
  if (missing.length > 0) {
    throw new BrokerError(
      BrokerErrorCode.BrokerLifecyclePolicyUnsupported,
      'Broker lifecycle policy unsupported by selected driver capabilities',
      {
        code: 'broker-lifecycle-policy-unsupported',
        policyId: policy.policyId,
        policyHash: policy.policyHash,
        missing,
        capabilities: capabilities.lifecycle,
      }
    )
  }
}

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------
interface QueuedInput {
  inputId: InputId
  input: InvocationInputWithId
}

type InvocationInputWithId = InvocationInput & { inputId: InputId }

/** Per-invocation in-memory record of a resolved input disposition. */
interface InputDispositionRecord {
  /** Stable fingerprint of the request content + policy, keyed by inputId. */
  fingerprint: string
  response: InvocationInputResponse
}

/**
 * Broker-owned pending permission request (C2). The pending state is held in
 * the broker (NOT the JSON-RPC request promise), survives controller
 * disconnect, and is retained until `deadlineAt`. `settle` resolves it exactly
 * once — by client response, reconnect respond, or deadline expiry.
 */
interface PendingPermissionRecord {
  params: PermissionRequestParams
  defaultDecision: 'allow' | 'deny'
  /** Absolute ISO-8601 deadline surfaced to reconnecting controllers. */
  deadlineAt: string
  settle(decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void
}

/** In-memory record of how a permission request settled (idempotency surface). */
interface SettledPermissionRecord {
  decision: 'allow' | 'deny'
  /** True when settled by deadline expiry — a later respond is then "expired". */
  expired: boolean
}

export interface Invocation {
  readonly invocationId: InvocationId
  readonly spec: HarnessInvocationSpec
  state: InvocationState
  capabilities: InvocationCapabilities
  driver: Driver
  continuation?: ContinuationUpdate | undefined
  terminalEmitted: boolean
  /** True once invocation.disposed has been emitted — keeps it idempotent. */
  disposedEmitted: boolean
  /** Manager-owned public status projection, driven by applyEventState. */
  currentTurnId?: TurnId | undefined
  currentInputId?: InputId | undefined
  childPid?: number | undefined
  exitCode?: number | null | undefined
  signal?: string | null | undefined
  /** Per-invocation FIFO queue of pending inputs. */
  pending: QueuedInput[]
  /** Self-clearing drain lock: set while a drain is in flight, cleared in .finally(). */
  drainPromise?: Promise<void> | undefined
  /** Short write lock for terminal-immediate busy inputs. This is not a turn queue. */
  steerPromise?: Promise<void> | undefined
  /** Monotonic counter for broker-assigned inputIds. */
  inputCounter: number
  /**
   * In-memory idempotency ledger for client-provided inputIds. A duplicate
   * inputId with byte-identical content/policy replays the original response;
   * a duplicate inputId with differing content/policy is a conflict. Surfaced
   * in the durability snapshot. Broker-survives-HRC-restart only (not on disk).
   */
  inputDispositions: Map<string, InputDispositionRecord>
  /**
   * Broker-owned pending permission requests, keyed by permissionRequestId.
   * Retained across controller disconnect until each request's absolute
   * deadline, and surfaced in the durability snapshot (C2). In-memory only.
   */
  pendingPermissions: Map<PermissionRequestId, PendingPermissionRecord>
  /**
   * How already-settled permission requests resolved, keyed by
   * permissionRequestId. Backs idempotent/conflict/expired `permission.respond`.
   */
  settledPermissions: Map<PermissionRequestId, SettledPermissionRecord>
}

export interface InvocationManagerOptions {
  sequencer: InvocationEventSequencer
  onEvent: (event: InvocationEventEnvelope) => void
  getClientCapabilities?: (() => ClientCapabilities) | undefined
  /**
   * Broker→client permission request transport. When provided, drivers can ask
   * the connected client to decide a permission request via
   * `DriverContext.requestPermission`. Absent when no outbound request
   * transport is available.
   */
  onPermissionRequest?:
    | ((params: PermissionRequestParams) => Promise<PermissionDecision>)
    | undefined
  maxInputQueueDepth?: number | undefined
  /** Clock for broker-owned permission deadlines. Defaults to wall-clock. */
  now?: (() => Date) | undefined
}

export interface InvocationManager {
  start(
    spec: HarnessInvocationSpec,
    driver: Driver,
    initialInput?: InvocationInput | undefined,
    dispatchEnv?: Record<string, string> | undefined,
    runtime?: InvocationRuntimeContext | undefined,
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
  ): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(invocationId: InvocationId): InvocationStatusResponse
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  permissionRespond(req: InvocationPermissionRespondRequest): InvocationPermissionRespondResponse
  get(invocationId: InvocationId): Invocation | undefined
  activeCount(): number
}

export function createInvocationManager(options: InvocationManagerOptions): InvocationManager {
  const { sequencer, onEvent, getClientCapabilities = () => ({}), onPermissionRequest } = options
  const now = options.now ?? (() => new Date())
  const maxQueueDepth = options.maxInputQueueDepth ?? DEFAULT_MAX_INPUT_QUEUE_DEPTH
  const invocations = new Map<string, Invocation>()

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

  // ---------------------------------------------------------------------------
  // Drain logic — promise-guarded, at most one drain in flight per ready window
  // ---------------------------------------------------------------------------
  function scheduleDrain(inv: Invocation): void {
    if (inv.drainPromise) return
    if (inv.pending.length === 0) return
    if (inv.state !== 'ready') return
    inv.drainPromise = doDrain(inv).finally(() => {
      inv.drainPromise = undefined
      // Reschedule if invocation is still ready with pending inputs — prevents
      // stalling when a mid-drain failure leaves items in the queue.
      if (inv.state === 'ready' && inv.pending.length > 0) {
        scheduleDrain(inv)
      }
    })
  }

  async function doDrain(inv: Invocation): Promise<void> {
    while (inv.pending.length > 0 && inv.state === 'ready') {
      const head = inv.pending.shift()!
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
      }
    }
  }

  /**
   * Emit broker-owned input.accepted, then call driver.applyInputNow.
   * turn.started is emitted by the driver via ctx.emit (notification pipeline).
   * This is the single code path for both immediate application and drain.
   */
  async function applyAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<{ turnId?: TurnId | undefined }> {
    // Broker owns input.accepted emission — before the driver applies the input
    const { inputId } = input
    emit(inv, 'input.accepted', { inputId, disposition: 'started' }, { inputId })
    const result = await inv.driver.applyInputNow(input)
    return result
  }

  async function attemptSteerAndEmit(
    inv: Invocation,
    input: InvocationInputWithId
  ): Promise<InvocationInputResponse> {
    const applySteerNow = inv.driver.applySteerNow
    if (applySteerNow === undefined) {
      return rejectQueueInput(inv, input.inputId, REASON_QUEUE_NOT_SUPPORTED)
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
          return rejectQueueInput(
            inv,
            input.inputId,
            String(err instanceof Error ? err.message : err)
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
    reason: string
  ): InvocationInputResponse {
    emit(inv, 'input.rejected', { inputId, reason }, { inputId })
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
    while (inv.pending.length > 0) {
      const item = inv.pending.shift()!
      emit(inv, 'input.rejected', { inputId: item.inputId, reason }, { inputId: item.inputId })
    }
  }

  // ---------------------------------------------------------------------------
  // whenBusy policy dispatch — one handler per policy (OCP): adding a policy is
  // adding a table entry, not editing an if-chain. Each handler receives the
  // resolved input and the originating request and returns the input response
  // (or throws for the rejection paths that surface as broker errors).
  // ---------------------------------------------------------------------------
  type BusyInputContext = {
    inv: Invocation
    input: InvocationInputWithId
    inputId: InputId
    req: InvocationInputRequest
  }

  async function handleQueueWhenBusy({
    inv,
    input,
    inputId,
    req,
  }: BusyInputContext): Promise<InvocationInputResponse> {
    // Only 'user' kind can be queued
    if (input.kind !== 'user') {
      return rejectQueueInput(inv, inputId, REASON_UNSUPPORTED_INPUT_KIND)
    }

    // Check composed queue capability
    const queueEnabled =
      inv.spec.interaction?.inputQueue === 'fifo' && inv.capabilities.input.queue === true
    if (!queueEnabled) {
      return rejectQueueInput(inv, inputId, REASON_QUEUE_NOT_SUPPORTED)
    }

    if (inv.spec.interaction?.mode === 'interactive' && inv.driver.applySteerNow !== undefined) {
      const response = await attemptSteerAndEmit(inv, input)
      recordDisposition(inv, req, response)
      return response
    }

    // Check depth cap
    if (inv.pending.length >= maxQueueDepth) {
      return rejectQueueInput(inv, inputId, REASON_QUEUE_FULL)
    }

    // Enqueue
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

  const busyPolicyHandlers: Record<
    InputPolicy['whenBusy'],
    (ctx: BusyInputContext) => Promise<InvocationInputResponse>
  > = {
    reject: async ({ inv, inputId }) => {
      emit(inv, 'input.rejected', { inputId, reason: REASON_BUSY_REJECTED }, { inputId })
      throw new BrokerError(BrokerErrorCode.InputRejected, REASON_BUSY_REJECTED, {
        invocationId: inv.invocationId,
      })
    },
    // interrupt_then_apply is centrally rejected in v1.
    interrupt_then_apply: async ({ inv, inputId }) =>
      rejectQueueInput(inv, inputId, REASON_UNSUPPORTED_BUSY_POLICY),
    queue: handleQueueWhenBusy,
  }

  // ---------------------------------------------------------------------------
  // Event state machine
  // ---------------------------------------------------------------------------
  function applyEventState(inv: Invocation, event: InvocationEventEnvelope): void {
    switch (event.type) {
      case 'invocation.started': {
        // Capture the child pid for the manager-owned status projection.
        const pid = (event.payload as { pid?: unknown } | undefined)?.pid
        if (typeof pid === 'number') {
          inv.childPid = pid
        }
        return
      }
      case 'invocation.ready':
        inv.state = 'ready'
        return
      case 'input.accepted':
        if (
          (event.payload as { disposition?: unknown } | undefined)?.disposition ===
          'attempted_steer'
        ) {
          return
        }
        // The input that drives the next turn — cleared when the turn ends.
        if (event.inputId !== undefined) {
          inv.currentInputId = event.inputId
        }
        return
      case 'turn.started':
        inv.state = 'turn_active'
        if (event.turnId !== undefined) {
          inv.currentTurnId = event.turnId
        }
        return
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        if (inv.state !== 'exited' && inv.state !== 'failed' && inv.state !== 'disposed') {
          inv.state = 'ready'
        }
        // Schedule drain if there are pending inputs and we transitioned to ready
        scheduleDrain(inv)
        return
      case 'invocation.stopping':
        inv.state = 'stopping'
        evictQueue(inv, REASON_INVOCATION_STOPPING)
        return
      case 'invocation.exited': {
        inv.state = 'exited'
        inv.terminalEmitted = true
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
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
        inv.state = 'failed'
        inv.terminalEmitted = true
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      case 'invocation.disposed':
        inv.state = 'disposed'
        inv.disposedEmitted = true
        inv.currentTurnId = undefined
        inv.currentInputId = undefined
        return
      case 'continuation.updated':
        inv.continuation = event.payload as ContinuationUpdate
        return
      case 'continuation.cleared':
        inv.continuation = undefined
        return
    }
  }

  // ---------------------------------------------------------------------------
  // Emit helper
  // ---------------------------------------------------------------------------
  function emit<TPayload>(
    inv: Invocation,
    type: InvocationEventEnvelope['type'],
    payload: TPayload,
    extra?: {
      turnId?: TurnId | undefined
      inputId?: InputId | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
      harnessGeneration?: number | undefined
      turnAttempt?: number | undefined
    }
  ): InvocationEventEnvelope<TPayload> {
    // Single central event-safety path before sequencing: constrain/normalize
    // well-known payloads and truncate oversized payloads against maxEventBytes.
    const { payload: safePayload, diagnostics } = normalizeEventPayload({
      type,
      payload,
      maxEventBytes: inv.spec.process.limits?.maxEventBytes,
    })

    const event = sequencer.next(inv.invocationId, type, safePayload, extra)
    if (inv.spec.correlation !== undefined) {
      event.correlation = inv.spec.correlation
    }
    applyEventState(inv, event as InvocationEventEnvelope)
    onEvent(event as InvocationEventEnvelope)

    // Follow-on diagnostics (e.g. truncation notices) are emitted as their own
    // events. Their payloads are small, so they never re-trigger truncation.
    if (diagnostics) {
      for (const diagnostic of diagnostics) {
        emit(inv, 'diagnostic', diagnostic, extra)
      }
    }

    return event as InvocationEventEnvelope<TPayload>
  }

  function emitTerminal(
    inv: Invocation,
    type: 'invocation.exited' | 'invocation.failed',
    payload: unknown
  ): void {
    if (inv.terminalEmitted) {
      return
    }
    inv.terminalEmitted = true
    emit(inv, type, payload)
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

  // ---------------------------------------------------------------------------
  // Broker-owned permission lifecycle (C2)
  // ---------------------------------------------------------------------------
  /**
   * Register a broker-owned pending permission request and return a promise that
   * resolves with the FINAL decision. Unlike the JSON-RPC request promise, this
   * pending state is broker-held: it survives controller disconnect and is
   * retained until an absolute `deadlineAt`. It settles exactly once — by the
   * connected client's response (`user`), a reconnected controller's respond
   * (`user`), or deadline expiry applying `defaultDecision` (`timeout`). The
   * `permission.resolved` audit event is emitted on settlement. A failed/closed
   * broker→client request does NOT settle the pending request; it stays pending
   * until the deadline or a respond.
   */
  function brokerRequestPermission(
    inv: Invocation,
    params: PermissionRequestParams
  ): Promise<PermissionDecision> {
    const defaultDecision = params.defaultDecision
    const timeoutMs = params.deadlineMs ?? DEFAULT_PERMISSION_TIMEOUT_MS
    const deadlineAt = new Date(now().getTime() + timeoutMs).toISOString()
    const extra = {
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(inv.currentInputId !== undefined ? { inputId: inv.currentInputId } : {}),
    }

    return new Promise<PermissionDecision>((resolveDriver) => {
      let settled = false

      const settle = (decision: 'allow' | 'deny', decidedBy: PermissionDecidedBy): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        inv.pendingPermissions.delete(params.permissionRequestId)
        inv.settledPermissions.set(params.permissionRequestId, {
          decision,
          expired: decidedBy === 'timeout',
        })
        emit(
          inv,
          'permission.resolved',
          { permissionRequestId: params.permissionRequestId, decision, decidedBy },
          extra
        )
        resolveDriver({ decision })
      }

      // setTimeout/onPermissionRequest are async, so `timer` is always assigned
      // before `settle` (which reads it) can run.
      const timer = setTimeout(() => settle(defaultDecision, 'timeout'), timeoutMs)

      inv.pendingPermissions.set(params.permissionRequestId, {
        params,
        defaultDecision,
        deadlineAt,
        settle,
      })

      // Ask the connected controller. A response settles by `user`; a rejection
      // (controller disconnect / handler error) is intentionally ignored so the
      // request stays pending until the deadline or a reconnect respond.
      if (onPermissionRequest !== undefined) {
        onPermissionRequest(params).then(
          (decision) => settle(decision.decision === 'allow' ? 'allow' : 'deny', 'user'),
          () => {}
        )
      }
    })
  }

  return {
    async start(
      spec: HarnessInvocationSpec,
      driver: Driver,
      initialInput?: InvocationInput | undefined,
      dispatchEnv?: Record<string, string> | undefined,
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

      const driverCaps = driver.capabilities()
      assertLifecyclePolicySupported(lifecyclePolicy, driverCaps)
      const composedQueue =
        driverCaps.input.queue === true &&
        // input.user is a capability-dependency check (queueing requires user-input capability),
        // NOT a second queue flag.
        driverCaps.input.user === true &&
        spec.interaction?.inputQueue === 'fifo'
      const capabilities: InvocationCapabilities = {
        ...driverCaps,
        input: {
          ...driverCaps.input,
          // Broker-composed: the public surface reflects the composed value,
          // NOT the raw driver-reported value.
          queue: composedQueue,
        },
      }

      const inv: Invocation = {
        invocationId,
        spec,
        state: 'starting',
        capabilities,
        driver,
        terminalEmitted: false,
        disposedEmitted: false,
        pending: [],
        inputCounter: 0,
        inputDispositions: new Map(),
        pendingPermissions: new Map(),
        settledPermissions: new Map(),
      }
      invocations.set(invocationId, inv)

      const ctx: DriverContext = {
        invocationId,
        clientCapabilities: getClientCapabilities(),
        ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        emit<TPayload>(
          type: InvocationEventType,
          payload: TPayload,
          extra?: Parameters<typeof emit>[3]
        ) {
          return emit(inv, type, payload, extra)
        },
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
        if (inv.state === 'starting') {
          emit(inv, 'invocation.started', {
            command: spec.process.command,
            args: spec.process.args,
            cwd: spec.process.cwd,
          })
        }
        if (inv.state !== 'ready') {
          emit(inv, 'invocation.ready', { state: 'ready' })
        }
      }

      inv.state = 'ready'

      // Apply initialInput through the same broker-owned path as client.input()
      if (initialInput !== undefined && !inv.terminalEmitted) {
        const inputId = resolveInputId(inv, initialInput)
        const inputWithId: InvocationInputWithId = { ...initialInput, inputId }
        await applyAndEmit(inv, inputWithId)
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
            `Duplicate inputId ${providedInputId} with differing content or policy`,
            { invocationId: inv.invocationId, inputId: providedInputId }
          )
        }
      }

      // Resolve inputId upfront — stable across all paths
      const rawInput = req.input
      const inputId = resolveInputId(inv, rawInput)
      const input: InvocationInputWithId = { ...rawInput, inputId }

      // Invalid state rejection
      if (inv.state !== 'ready' && inv.state !== 'turn_active') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot accept input in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      if (input.kind === 'steer' && !inv.capabilities.input.steer) {
        emit(
          inv,
          'input.rejected',
          { inputId, reason: 'UnsupportedCapability: input.steer' },
          { inputId }
        )
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          'UnsupportedCapability: input.steer'
        )
      }
      if (input.kind === 'append_context' && !inv.capabilities.input.appendContext) {
        emit(
          inv,
          'input.rejected',
          { inputId, reason: 'UnsupportedCapability: input.appendContext' },
          { inputId }
        )
        throw new BrokerError(
          BrokerErrorCode.UnsupportedCapability,
          'UnsupportedCapability: input.appendContext'
        )
      }

      // --- State: ready → apply immediately ---
      if (inv.state === 'ready') {
        const result = await applyAndEmit(inv, input)
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
      if (!policy) {
        throw new BrokerError(
          BrokerErrorCode.InputRejected,
          'Input rejected: turn already active (no policy specified)',
          { invocationId: inv.invocationId }
        )
      }

      const handler = busyPolicyHandlers[policy.whenBusy]
      if (handler === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InputRejected,
          `Unknown whenBusy policy: ${(policy as { whenBusy: string }).whenBusy}`,
          { invocationId: inv.invocationId }
        )
      }
      return handler({ inv, input, inputId, req })
    },

    async interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      const inv = requireInvocation(req.invocationId)
      if (TERMINAL_STATES.has(inv.state) || inv.state === 'disposed') {
        return { accepted: false, effect: 'no_active_turn', reason: `Invocation is ${inv.state}` }
      }

      return inv.driver.interrupt(req)
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

    status(invocationId: InvocationId): InvocationStatusResponse {
      const inv = requireInvocation(invocationId)
      const response: InvocationStatusResponse = {
        invocationId: inv.invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
        continuation: inv.continuation,
      }
      if (inv.currentTurnId !== undefined) {
        response.currentTurnId = inv.currentTurnId
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

    permissionRespond(
      req: InvocationPermissionRespondRequest
    ): InvocationPermissionRespondResponse {
      const inv = requireInvocation(req.invocationId)

      const pending = inv.pendingPermissions.get(req.permissionRequestId)
      if (pending !== undefined) {
        // Settle the broker-owned pending request: emits permission.resolved and
        // resolves the driver's awaiting decision.
        pending.settle(req.decision, 'user')
        return {
          status: 'accepted',
          permissionRequestId: req.permissionRequestId,
          decision: req.decision,
        }
      }

      const settled = inv.settledPermissions.get(req.permissionRequestId)
      if (settled === undefined) {
        throw new BrokerError(
          BrokerErrorCode.UnknownPermissionRequest,
          `Unknown permission request: ${req.permissionRequestId}`,
          { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
        )
      }

      // Settled by deadline expiry — a respond can no longer take effect.
      if (settled.expired) {
        throw new BrokerError(
          BrokerErrorCode.PermissionResponseExpired,
          `Permission request already expired: ${req.permissionRequestId}`,
          { invocationId: req.invocationId, permissionRequestId: req.permissionRequestId }
        )
      }

      // Already answered: replay the original decision, or conflict on a mismatch.
      if (settled.decision === req.decision) {
        return {
          status: 'duplicate',
          permissionRequestId: req.permissionRequestId,
          originalDecision: settled.decision,
        }
      }
      throw new BrokerError(
        BrokerErrorCode.PermissionResponseConflict,
        `Permission request already decided ${settled.decision}; cannot change to ${req.decision}`,
        {
          invocationId: req.invocationId,
          permissionRequestId: req.permissionRequestId,
          originalDecision: settled.decision,
          attemptedDecision: req.decision,
        }
      )
    },

    get(invocationId: InvocationId): Invocation | undefined {
      return invocations.get(invocationId)
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
