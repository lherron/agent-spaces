import type {
  ClientCapabilities,
  HarnessInvocationSpec,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'

export interface ApplyInputResult {
  turnId?: string | undefined
}

export interface Driver {
  readonly kind: string
  readonly version: string
  readonly acceptsSequentialUserInputs: boolean
  capabilities(): InvocationCapabilities
  start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>
  applyInputNow(input: InvocationInput): Promise<ApplyInputResult>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  dispose(): Promise<void>
}

export interface DriverContext {
  invocationId: string
  clientCapabilities: ClientCapabilities
  emit<TPayload>(
    type: InvocationEventType,
    payload: TPayload,
    extra?: {
      turnId?: string | undefined
      inputId?: string | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
    }
  ): InvocationEventEnvelope<TPayload>
}

export interface DriverStartResult {
  ok: true
}
