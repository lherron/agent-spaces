import type {
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from '../drivers/driver'
import { BrokerError } from '../errors'

export interface TestDriverController {
  readonly inputs: InvocationInput[]
  readonly activeInput: InvocationInput | undefined
  readonly activeTurnId: TurnId | undefined
  completeActiveTurn(finalOutput?: string): void
  failActiveTurn(message?: string): void
  interruptActiveTurn(reason?: string): void
}

export interface TestDriverOptions {
  failInputIds?: Iterable<string> | undefined
  inputCapabilities?: Partial<InvocationCapabilities['input']> | undefined
}

export interface TestDriverHandle {
  driver: Driver
  controller: TestDriverController
}

const TEST_CAPABILITIES: InvocationCapabilities = {
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
}

export function createTestDriver(options: TestDriverOptions = {}): TestDriverHandle {
  const failInputIds = new Set(options.failInputIds ?? [])
  const capabilities: InvocationCapabilities = {
    ...TEST_CAPABILITIES,
    input: {
      ...TEST_CAPABILITIES.input,
      ...options.inputCapabilities,
    },
  }
  const inputs: InvocationInput[] = []
  let ctx: DriverContext | undefined
  let activeInput: InvocationInput | undefined
  let activeTurnId: TurnId | undefined
  let turnCounter = 0

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
    inputs,

    get activeInput(): InvocationInput | undefined {
      return activeInput
    },

    get activeTurnId(): TurnId | undefined {
      return activeTurnId
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
  }

  const driver: Driver = {
    kind: 'test-driver',
    version: '0.1.0',

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

      // Driver emits turn.started — broker owns input.accepted separately
      requireCtx().emit('turn.started', { turnId: activeTurnId }, { turnId: activeTurnId, inputId })

      return { turnId: activeTurnId }
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      if (activeTurnId === undefined) {
        return { accepted: false, effect: 'no_active_turn' }
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

  return { driver, controller }
}
