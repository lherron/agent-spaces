import type {
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEvent,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  SubmissionClass,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  CONSERVATIVE_LIFECYCLE_CAPABILITIES,
} from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../capture/capture-gate'
import type {
  ApplyInputResult,
  BracketMintingMode,
  Driver,
  DriverContext,
  DriverStartResult,
} from '../drivers/driver'
import { BROKER_ONLY_AUTHORITY } from '../drivers/evidence-authority'
import { BrokerError } from '../errors'

export interface TestDriverController {
  readonly inputs: InvocationInput[]
  readonly steeredInputs: InvocationInput[]
  readonly activeInput: InvocationInput | undefined
  readonly activeTurnId: TurnId | undefined
  observeActiveTurnStart(): void
  completeActiveTurn(finalOutput?: string): void
  failActiveTurn(message?: string): void
  interruptActiveTurn(reason?: string): void
  /** Emit a `tool.call.started` on the active turn (opens a bracket, T-06550). */
  startToolCall(toolCallId: string, name?: string): void
  /** Emit a `tool.call.completed` closing the bracket for `toolCallId`. */
  completeToolCall(toolCallId: string, name?: string): void
  /**
   * Model provider death: emit `invocation.failed` directly (as a driver would
   * on a harness stall/crash), without closing any open tool call — exercises
   * the teardown-synthesized `tool.call.failed` path (T-06550, acceptance 3).
   */
  crashProvider(message?: string): void
  /** Emit a continuation.cleared with the given reason (simulates /quit, /clear). */
  clearContinuation(reason: string): void
  /**
   * Commit one raw provider record through the invocation's capture gate and
   * report `outcome` for it — the seam that lets a test drive the normalization
   * cursor (including a blocked-unknown) through the REAL broker rather than a
   * stand-in.
   */
  captureRow(nativeType: string, body: unknown, outcome: NormalizeOutcome): void
  /**
   * Emit an arbitrary driver event through the REAL manager seam. The
   * cross-driver provenance invariant needs one event per family, and the
   * shaped helpers above cover only the turn/tool lifecycle.
   */
  emitRaw(
    type: InvocationEventType,
    payload: unknown,
    extra?: Parameters<DriverContext['emitEvent']>[1]
  ): void
  setHarnessLocalQueueDepth(depth: number): void
  startHarnessLocalTurn(inputId: string): void
  notifyAdmissionStateChanged(): void
}

export interface TestDriverOptions {
  failInputIds?: Iterable<string> | undefined
  inputCapabilities?: Partial<InvocationCapabilities['input']> | undefined
  supportsSteer?: boolean | undefined
  /**
   * When true, `applyInputNow` returns the allocated turnId but does NOT emit
   * its own `turn.started` — modelling a claude-code-tmux idle dispatch where
   * the Claude `UserPromptSubmit` hook never fires. The broker must still
   * guarantee the bracket from the returned turnId (T-04846).
   */
  suppressTurnStarted?: boolean | undefined
  bracketMintingMode?: BracketMintingMode | undefined
  preemptMode?: import('../drivers/driver').PreemptMode | null | undefined
  admissionRejectionReason?: ((admissionClass: SubmissionClass) => string | undefined) | undefined
  runtimeHealth?: Driver['runtimeHealth'] | undefined
  interruptRejectionReason?: string | undefined
  deferInterruptTerminal?: boolean | undefined
  /**
   * Stand in for a REAL driver's declaration. The cross-driver provenance
   * invariant (T-07870) has to exercise every shipped driver's declared
   * authority through the real manager seam, and those declarations are the
   * only part of a driver that decides what provenance a bare emit gets.
   */
  evidenceAuthority?: Driver['evidenceAuthority'] | undefined
  nativeSourceKind?: Driver['nativeSourceKind'] | undefined
  kind?: string | undefined
}

export interface TestDriverHandle {
  driver: Driver
  controller: TestDriverController
}

const TEST_CAPABILITIES: InvocationCapabilities = {
  admission: { classes: ['queue', 'exclusive'] },
  bracketMintingMode: 'delivery-asserted',
  queue: { cancelHarnessLocal: false },
  preempt: { mode: null },
  steer: { landingEvidence: null },
  interrupt: { landingEvidence: null },
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: true,
  },
  turns: {
    concurrency: 'single',
    interrupt: 'unsupported',
  },
  continuation: {
    supported: false,
  },
  events: {
    assistantDeltas: false,
    toolCalls: false,
    usage: false,
    diagnostics: true,
  },
  control: {
    stop: true,
    dispose: true,
  },
  lifecycle: CONSERVATIVE_LIFECYCLE_CAPABILITIES,
}

export function createTestDriver(options: TestDriverOptions = {}): TestDriverHandle {
  const failInputIds = new Set(options.failInputIds ?? [])
  const preemptMode = options.preemptMode === undefined ? 'atomic' : options.preemptMode
  const capabilities: InvocationCapabilities = {
    ...TEST_CAPABILITIES,
    admission: {
      classes: [
        ...(options.supportsSteer === true ? (['steer'] as const) : []),
        'queue',
        'exclusive',
        ...(preemptMode !== null ? (['preempt'] as const) : []),
      ],
    },
    bracketMintingMode: options.bracketMintingMode ?? 'delivery-asserted',
    preempt: { mode: preemptMode },
    steer: { landingEvidence: options.supportsSteer === true ? 'asserted' : null },
    input: {
      ...TEST_CAPABILITIES.input,
      ...options.inputCapabilities,
      steer: options.inputCapabilities?.steer ?? TEST_CAPABILITIES.input.steer,
    },
  }
  const inputs: InvocationInput[] = []
  const steeredInputs: InvocationInput[] = []
  let ctx: DriverContext | undefined
  let activeInput: InvocationInput | undefined
  let activeTurnId: TurnId | undefined
  let turnCounter = 0
  let harnessLocalQueueDepth = 0

  const requireCtx = (): DriverContext => {
    if (ctx === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'test-driver is not started')
    }
    return ctx
  }

  const requireActiveTurn = (): { input: InvocationInput; turnId: TurnId } => {
    if (activeInput === undefined || activeTurnId === undefined) {
      throw new BrokerError(BrokerErrorCode.InvalidInvocationState, 'No active test turn')
    }
    return { input: activeInput, turnId: activeTurnId }
  }

  const clearActiveTurn = (): void => {
    activeInput = undefined
    activeTurnId = undefined
  }

  const controller: TestDriverController = {
    emitRaw(type, payload, extra) {
      // The pairing of type to payload is the caller's to get right here: this
      // seam exists so a test can emit ONE event per family without a shaped
      // helper for each, and the envelope validator rejects a mismatch anyway.
      requireCtx().emitEvent({ type, payload } as InvocationEvent, extra)
    },
    inputs,
    steeredInputs,

    get activeInput(): InvocationInput | undefined {
      return activeInput
    },

    get activeTurnId(): TurnId | undefined {
      return activeTurnId
    },

    observeActiveTurnStart(): void {
      const active = requireActiveTurn()
      requireCtx().emit(
        'turn.started',
        { turnId: active.turnId, source: 'hook-observed' },
        { turnId: active.turnId, inputId: active.input.inputId }
      )
    },

    completeActiveTurn(finalOutput = 'test turn complete'): void {
      const active = requireActiveTurn()
      clearActiveTurn()
      requireCtx().emit(
        'turn.completed',
        { turnId: active.turnId, status: 'completed', finalOutput },
        { turnId: active.turnId, inputId: active.input.inputId }
      )
    },

    failActiveTurn(message = 'test turn failed'): void {
      const active = requireActiveTurn()
      clearActiveTurn()
      requireCtx().emit(
        'turn.failed',
        { turnId: active.turnId, status: 'failed', message },
        { turnId: active.turnId, inputId: active.input.inputId }
      )
    },

    interruptActiveTurn(reason = 'test turn interrupted'): void {
      const active = requireActiveTurn()
      clearActiveTurn()
      requireCtx().emit(
        'turn.interrupted',
        { turnId: active.turnId, status: 'interrupted', reason },
        { turnId: active.turnId, inputId: active.input.inputId }
      )
    },

    startToolCall(toolCallId: string, name = 'command'): void {
      const active = requireActiveTurn()
      requireCtx().emit(
        'tool.call.started',
        { toolCallId: toolCallId as ToolCallId, name },
        { turnId: active.turnId, itemId: toolCallId }
      )
    },

    completeToolCall(toolCallId: string, name = 'command'): void {
      const active = requireActiveTurn()
      requireCtx().emit(
        'tool.call.completed',
        { toolCallId: toolCallId as ToolCallId, name, isError: false },
        { turnId: active.turnId, itemId: toolCallId }
      )
    },

    crashProvider(message = 'provider died'): void {
      clearActiveTurn()
      requireCtx().emit('invocation.failed', { message, reason: 'harness-stalled' })
    },

    clearContinuation(reason: string): void {
      requireCtx().emit('continuation.cleared', { reason })
    },

    captureRow(nativeType: string, body: unknown, outcome: NormalizeOutcome): void {
      const capture = requireCtx().capture
      if (capture === undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'test-driver has no capture gate'
        )
      }
      capture.ingest(
        {
          provider: 'test',
          driverKind: 'test-driver',
          sourceKind: 'provider-jsonl',
          sourceKey: 'test-transcript',
          nativeType,
          rawBytes: Buffer.from(JSON.stringify(body), 'utf8'),
        },
        (captured) => {
          if (outcome.disposition === 'normalized') {
            requireCtx().emit(
              'diagnostic',
              { level: 'info', source: 'harness', message: nativeType },
              {
                driver: { kind: 'test-driver', rawType: nativeType },
                provenance: captured.provenance(),
              }
            )
          }
          return outcome
        }
      )
    },

    setHarnessLocalQueueDepth(depth: number): void {
      harnessLocalQueueDepth = Math.max(0, depth)
      requireCtx().admissionStateChanged?.()
    },

    notifyAdmissionStateChanged(): void {
      requireCtx().admissionStateChanged?.()
    },

    startHarnessLocalTurn(inputId: string): void {
      if (activeTurnId !== undefined) {
        throw new BrokerError(
          BrokerErrorCode.InvalidInvocationState,
          'A test turn is already active'
        )
      }
      harnessLocalQueueDepth = Math.max(0, harnessLocalQueueDepth - 1)
      requireCtx().admissionStateChanged?.()
      turnCounter += 1
      activeTurnId = `turn_test_${turnCounter}` as TurnId
      activeInput = {
        inputId: inputId as InputId,
        kind: 'user',
        content: [{ type: 'text', text: inputId }],
      }
      requireCtx().emit(
        'turn.started',
        { turnId: activeTurnId, inputId: inputId as InputId, source: 'hook-observed' },
        { turnId: activeTurnId, inputId: inputId as InputId }
      )
    },
  }

  const driver: Driver = {
    kind: options.kind ?? 'test-driver',
    version: '0.1.0',
    bracketMintingMode: options.bracketMintingMode ?? 'delivery-asserted',
    evidenceAuthority: options.evidenceAuthority ?? BROKER_ONLY_AUTHORITY,
    nativeSourceKind: options.nativeSourceKind ?? 'provider-jsonl',
    preemptMode,
    steerLandingEvidence: options.supportsSteer ? 'asserted' : null,
    interruptLandingEvidence: null,

    ...(options.admissionRejectionReason !== undefined
      ? { admissionRejectionReason: options.admissionRejectionReason }
      : {}),
    ...(options.runtimeHealth !== undefined ? { runtimeHealth: options.runtimeHealth } : {}),

    probeAdmissionState() {
      return { harnessLocalQueueDepth }
    },

    capabilities(): InvocationCapabilities {
      return capabilities
    },

    async start(
      _spec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      ctx = driverCtx
      return { ok: true }
    },

    async applyInputNow(input: InvocationInput): Promise<ApplyInputResult> {
      const inputId = input.inputId ?? (`input_test_${inputs.length + 1}` as InputId)
      const resolved = { ...input, inputId }

      if (failInputIds.has(inputId)) {
        throw new BrokerError(BrokerErrorCode.InputRejected, `test-driver failed input ${inputId}`)
      }

      inputs.push(resolved)
      activeInput = resolved
      turnCounter += 1
      activeTurnId = `turn_test_${turnCounter}` as TurnId

      // Driver emits turn.started — broker owns input.accepted separately. When
      // suppressTurnStarted is set, the driver stays silent (no hook fired) and
      // relies on the broker's delivery-synthesized bracket (T-04846).
      if (options.suppressTurnStarted !== true) {
        requireCtx().emit(
          'turn.started',
          { turnId: activeTurnId },
          { turnId: activeTurnId, inputId }
        )
      }

      return { turnId: activeTurnId }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (options.interruptRejectionReason !== undefined) {
        return {
          accepted: false,
          effect: 'unsupported',
          reason: options.interruptRejectionReason,
        }
      }
      if (activeTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
      }
      if (options.deferInterruptTerminal === true) {
        return { accepted: true, effect: 'turn_interrupted' }
      }
      controller.interruptActiveTurn('driver interrupt')
      return { accepted: true, effect: 'turn_interrupted' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      clearActiveTurn()
      return { accepted: true, state: 'exited' }
    },

    async dispose(): Promise<void> {
      ctx = undefined
      clearActiveTurn()
      inputs.length = 0
    },
  }

  if (options.supportsSteer === true) {
    driver.applySteerNow = async (input: InvocationInput): Promise<void> => {
      const inputId = input.inputId ?? (`input_test_steer_${steeredInputs.length + 1}` as InputId)
      const resolved = { ...input, inputId }
      steeredInputs.push(resolved)
    }
  }

  return { driver, controller }
}
