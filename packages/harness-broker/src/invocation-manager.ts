import type {
  ClientCapabilities,
  ContinuationUpdate,
  HarnessInvocationSpec,
  InputId,
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
  InvocationRuntimeContext,
  InvocationStartResponse,
  InvocationState,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { Driver, DriverContext } from './drivers/driver'
import { BrokerError } from './errors'
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

/** Terminal states that allow dispose. */
const TERMINAL_STATES = new Set<InvocationState>(['exited', 'failed'])

// ---------------------------------------------------------------------------
// Queue types
// ---------------------------------------------------------------------------
interface QueuedInput {
  inputId: InputId
  input: InvocationInputWithId
}

type InvocationInputWithId = InvocationInput & { inputId: InputId }

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
  /** Monotonic counter for broker-assigned inputIds. */
  inputCounter: number
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
}

export interface InvocationManager {
  start(
    spec: HarnessInvocationSpec,
    driver: Driver,
    initialInput?: InvocationInput | undefined,
    dispatchEnv?: Record<string, string> | undefined,
    runtime?: InvocationRuntimeContext | undefined
  ): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(invocationId: InvocationId): InvocationStatusResponse
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  get(invocationId: InvocationId): Invocation | undefined
  activeCount(): number
}

export function createInvocationManager(options: InvocationManagerOptions): InvocationManager {
  const { sequencer, onEvent, getClientCapabilities = () => ({}), onPermissionRequest } = options
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
    emit(inv, 'input.accepted', { inputId }, { inputId })
    const result = await inv.driver.applyInputNow(input)
    return result
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

  return {
    async start(
      spec: HarnessInvocationSpec,
      driver: Driver,
      initialInput?: InvocationInput | undefined,
      dispatchEnv?: Record<string, string> | undefined,
      runtime?: InvocationRuntimeContext | undefined
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
          ? { requestPermission: (params) => onPermissionRequest(params) }
          : {}),
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
      }
    },

    async input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
      const inv = requireInvocation(req.invocationId)

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
        return {
          inputId,
          accepted: true,
          disposition: 'started',
          turnId: result.turnId,
        }
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

      // whenBusy: 'reject'
      if (policy.whenBusy === 'reject') {
        emit(inv, 'input.rejected', { inputId, reason: REASON_BUSY_REJECTED }, { inputId })
        throw new BrokerError(BrokerErrorCode.InputRejected, REASON_BUSY_REJECTED, {
          invocationId: inv.invocationId,
        })
      }

      // whenBusy: 'interrupt_then_apply' — centrally rejected in v1
      if (policy.whenBusy === 'interrupt_then_apply') {
        return rejectQueueInput(inv, inputId, REASON_UNSUPPORTED_BUSY_POLICY)
      }

      // whenBusy: 'queue'
      if (policy.whenBusy === 'queue') {
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

        // Check depth cap
        if (inv.pending.length >= maxQueueDepth) {
          return rejectQueueInput(inv, inputId, REASON_QUEUE_FULL)
        }

        // Enqueue
        inv.pending.push({ inputId, input })
        emit(inv, 'input.queued', { inputId }, { inputId })
        return {
          inputId,
          accepted: true,
          disposition: 'queued',
        }
      }

      // Fallback: unknown policy
      throw new BrokerError(
        BrokerErrorCode.InputRejected,
        `Unknown whenBusy policy: ${(policy as { whenBusy: string }).whenBusy}`,
        { invocationId: inv.invocationId }
      )
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
