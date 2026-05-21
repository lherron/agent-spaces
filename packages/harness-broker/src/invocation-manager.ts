import type {
  ClientCapabilities,
  ContinuationUpdate,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationDisposeRequest,
  InvocationDisposeResponse,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStartResponse,
  InvocationState,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { Driver, DriverContext } from './drivers/driver'
import { BrokerError } from './errors'
import type { InvocationEventSequencer } from './events'
import { buildEnvSecrets, redactPayload, safeStartedPayload } from './security/redaction'

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
  inputId: string
  input: InvocationInput
}

export interface Invocation {
  readonly invocationId: string
  readonly spec: HarnessInvocationSpec
  state: InvocationState
  capabilities: InvocationCapabilities
  driver: Driver
  continuation?: ContinuationUpdate | undefined
  terminalEmitted: boolean
  envSecrets: Set<string>
  /** Per-invocation FIFO queue of pending inputs. */
  pending: QueuedInput[]
  /** Whether a queueMicrotask drain is scheduled but not yet executed. */
  draining: boolean
  /** Monotonic counter for broker-assigned inputIds. */
  inputCounter: number
}

export interface InvocationManagerOptions {
  sequencer: InvocationEventSequencer
  onEvent: (event: InvocationEventEnvelope) => void
  getClientCapabilities?: (() => ClientCapabilities) | undefined
  maxInputQueueDepth?: number | undefined
}

export interface InvocationManager {
  start(
    spec: HarnessInvocationSpec,
    driver: Driver,
    initialInput?: InvocationInput | undefined
  ): Promise<InvocationStartResponse>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  status(invocationId: string): InvocationStatusResponse
  dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse>
  get(invocationId: string): Invocation | undefined
  activeCount(): number
}

export function createInvocationManager(options: InvocationManagerOptions): InvocationManager {
  const { sequencer, onEvent, getClientCapabilities = () => ({}) } = options
  const maxQueueDepth = options.maxInputQueueDepth ?? DEFAULT_MAX_INPUT_QUEUE_DEPTH
  const invocations = new Map<string, Invocation>()

  function requireInvocation(invocationId: string): Invocation {
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
  // Drain logic — microtask-scheduled, at most one per ready window
  // ---------------------------------------------------------------------------
  function scheduleDrain(inv: Invocation): void {
    if (inv.draining) return
    if (inv.pending.length === 0) return
    if (inv.state !== 'ready') return
    inv.draining = true
    queueMicrotask(() => drainOne(inv))
  }

  function drainOne(inv: Invocation): void {
    if (inv.pending.length === 0 || inv.state !== 'ready') {
      inv.draining = false
      return
    }
    const head = inv.pending.shift()!
    try {
      const inputWithId: InvocationInput = { ...head.input, inputId: head.inputId }
      // applyInputNow is async but we fire-and-forget inside the microtask.
      // On success the driver emits turn.started via ctx.emit which transitions
      // state to turn_active, preventing further same-window drains.
      void applyAndEmit(inv, inputWithId, head.inputId).catch((err) => {
        // Input failed at the driver level — reject this item and attempt
        // the next item if the invocation is still ready.
        emit(inv, 'input.rejected', { inputId: head.inputId, reason: String(err?.message ?? err) }, { inputId: head.inputId })
        if (inv.state === 'ready' && inv.pending.length > 0) {
          queueMicrotask(() => drainOne(inv))
        } else {
          inv.draining = false
        }
      })
    } catch (err) {
      emit(inv, 'input.rejected', { inputId: head.inputId, reason: String(err instanceof Error ? err.message : err) }, { inputId: head.inputId })
      if (inv.state === 'ready' && inv.pending.length > 0) {
        queueMicrotask(() => drainOne(inv))
      } else {
        inv.draining = false
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
    input: InvocationInput,
    inputId: string
  ): Promise<{ turnId?: string | undefined }> {
    // Broker owns input.accepted emission — before the driver applies the input
    emit(inv, 'input.accepted', { inputId }, { inputId })
    const result = await inv.driver.applyInputNow(input)
    // After applyInputNow the driver will have emitted turn.started via ctx.emit,
    // transitioning state to turn_active and preventing further same-window drains.
    inv.draining = false
    return result
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
      case 'invocation.ready':
        inv.state = 'ready'
        return
      case 'turn.started':
        inv.state = 'turn_active'
        return
      case 'turn.completed':
      case 'turn.failed':
      case 'turn.interrupted':
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
      case 'invocation.exited':
        inv.state = 'exited'
        inv.terminalEmitted = true
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
        return
      case 'invocation.failed':
        inv.state = 'failed'
        inv.terminalEmitted = true
        evictQueue(inv, REASON_INVOCATION_TERMINATED)
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
      turnId?: string | undefined
      inputId?: string | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
    }
  ): InvocationEventEnvelope<TPayload> {
    // Apply redaction before sequencing: constrain invocation.started and scrub secrets.
    let safePayload: TPayload = payload
    if (type === 'invocation.started') {
      safePayload = safeStartedPayload(payload) as TPayload
    }
    if (inv.envSecrets.size > 0) {
      safePayload = redactPayload(safePayload, inv.envSecrets) as TPayload
    }

    const event = sequencer.next(inv.invocationId, type, safePayload, extra)
    if (inv.spec.correlation !== undefined) {
      event.correlation = inv.spec.correlation
    }
    applyEventState(inv, event)
    onEvent(event)
    return event
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
  function resolveInputId(inv: Invocation, input: InvocationInput): string {
    if (input.inputId) return input.inputId
    inv.inputCounter += 1
    return `input_${inv.invocationId}_${inv.inputCounter}`
  }

  return {
    async start(
      spec: HarnessInvocationSpec,
      driver: Driver,
      initialInput?: InvocationInput | undefined
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
        `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

      // Capability composition: broker composes the public queue capability
      // from the driver flag, spec interaction config, and base user capability.
      const driverCaps = driver.capabilities()
      const composedQueue =
        driver.acceptsSequentialUserInputs &&
        spec.interaction?.inputQueue === 'fifo' &&
        driverCaps.input.user === true
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
        envSecrets: buildEnvSecrets(spec.process.env),
        pending: [],
        draining: false,
        inputCounter: 0,
      }
      invocations.set(invocationId, inv)

      const ctx: DriverContext = {
        invocationId,
        clientCapabilities: getClientCapabilities(),
        emit<TPayload>(
          type: InvocationEventType,
          payload: TPayload,
          extra?: Parameters<typeof emit>[3]
        ) {
          return emit(inv, type, payload, extra)
        },
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
          emit(inv, 'invocation.ready', {})
        }
      }

      inv.state = 'ready'

      // Apply initialInput through the same broker-owned path as client.input()
      if (initialInput !== undefined && !inv.terminalEmitted) {
        const inputId = resolveInputId(inv, initialInput)
        const inputWithId: InvocationInput = { ...initialInput, inputId }
        await applyAndEmit(inv, inputWithId, inputId)
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
      const inputId = resolveInputId(inv, req.input)
      const input: InvocationInput = { ...req.input, inputId }

      // Invalid state rejection
      if (
        inv.state !== 'ready' &&
        inv.state !== 'turn_active'
      ) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot accept input in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      // --- State: ready → apply immediately ---
      if (inv.state === 'ready') {
        // Capability gate — reject unsupported input kinds before applying
        if (input.kind === 'steer' && !inv.capabilities.input.steer) {
          emit(inv, 'input.rejected', { inputId, reason: 'UnsupportedCapability: input.steer' }, { inputId })
          throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'UnsupportedCapability: input.steer')
        }
        if (input.kind === 'append_context' && !inv.capabilities.input.appendContext) {
          emit(inv, 'input.rejected', { inputId, reason: 'UnsupportedCapability: input.appendContext' }, { inputId })
          throw new BrokerError(BrokerErrorCode.UnsupportedCapability, 'UnsupportedCapability: input.appendContext')
        }

        const result = await applyAndEmit(inv, input, inputId)
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
        throw new BrokerError(
          BrokerErrorCode.InputRejected,
          REASON_BUSY_REJECTED,
          { invocationId: inv.invocationId }
        )
      }

      // whenBusy: 'interrupt_then_apply' — centrally rejected in v1
      if (policy.whenBusy === 'interrupt_then_apply') {
        emit(inv, 'input.rejected', { inputId, reason: REASON_UNSUPPORTED_BUSY_POLICY }, { inputId })
        return {
          inputId,
          accepted: false,
          disposition: 'rejected',
          reason: REASON_UNSUPPORTED_BUSY_POLICY,
        }
      }

      // whenBusy: 'queue'
      if (policy.whenBusy === 'queue') {
        // Only 'user' kind can be queued
        if (input.kind !== 'user') {
          emit(inv, 'input.rejected', { inputId, reason: REASON_UNSUPPORTED_INPUT_KIND }, { inputId })
          return {
            inputId,
            accepted: false,
            disposition: 'rejected',
            reason: REASON_UNSUPPORTED_INPUT_KIND,
          }
        }

        // Check composed queue capability
        const queueEnabled =
          inv.spec.interaction?.inputQueue === 'fifo' && inv.capabilities.input.queue === true
        if (!queueEnabled) {
          emit(inv, 'input.rejected', { inputId, reason: REASON_QUEUE_NOT_SUPPORTED }, { inputId })
          return {
            inputId,
            accepted: false,
            disposition: 'rejected',
            reason: REASON_QUEUE_NOT_SUPPORTED,
          }
        }

        // Check depth cap
        if (inv.pending.length >= maxQueueDepth) {
          emit(inv, 'input.rejected', { inputId, reason: REASON_QUEUE_FULL }, { inputId })
          return {
            inputId,
            accepted: false,
            disposition: 'rejected',
            reason: REASON_QUEUE_FULL,
          }
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

    status(invocationId: string): InvocationStatusResponse {
      const inv = requireInvocation(invocationId)
      return {
        invocationId: inv.invocationId,
        state: inv.state,
        capabilities: inv.capabilities,
        continuation: inv.continuation,
      }
    },

    async dispose(req: InvocationDisposeRequest): Promise<InvocationDisposeResponse> {
      const inv = requireInvocation(req.invocationId)

      if (!TERMINAL_STATES.has(inv.state) && inv.state !== 'disposed') {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          `Cannot dispose invocation in state: ${inv.state}`,
          { invocationId: inv.invocationId, state: inv.state }
        )
      }

      await inv.driver.dispose()
      inv.state = 'disposed'

      return { disposed: true }
    },

    get(invocationId: string): Invocation | undefined {
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
