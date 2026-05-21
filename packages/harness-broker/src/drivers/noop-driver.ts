import type {
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from '../errors'
import type { ApplyInputResult, Driver, DriverContext, DriverStartResult } from './driver'

export interface NoopDriverOptions {
  /** Which terminal state to enter on stop: 'exited' or 'failed'. */
  terminal?: 'exited' | 'failed' | undefined
}

const NOOP_CAPABILITIES: InvocationCapabilities = {
  input: {
    user: true,
    steer: false,
    appendContext: false,
    localImages: false,
    fileRefs: false,
    queue: false,
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

export function createNoopDriver(options: NoopDriverOptions = {}): Driver {
  const terminal = options.terminal ?? 'exited'
  let ctx: DriverContext | undefined

  return {
    kind: 'noop-driver',
    version: '0.1.0',
    acceptsSequentialUserInputs: false,

    capabilities(): InvocationCapabilities {
      return NOOP_CAPABILITIES
    },

    async start(
      _spec: HarnessInvocationSpec,
      driverCtx: DriverContext
    ): Promise<DriverStartResult> {
      ctx = driverCtx
      return { ok: true }
    },

    async applyInputNow(_input: InvocationInput): Promise<ApplyInputResult> {
      throw new BrokerError(
        BrokerErrorCode.UnsupportedCapability,
        'noop-driver does not support input'
      )
    },

    async interrupt(_req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
      return { accepted: false, effect: 'unsupported', reason: 'noop-driver' }
    },

    async stop(_req: InvocationStopRequest): Promise<InvocationStopResponse> {
      void ctx
      return { accepted: true, state: terminal === 'exited' ? 'exited' : 'failed' }
    },

    async dispose(): Promise<void> {
      ctx = undefined
    },
  }
}
