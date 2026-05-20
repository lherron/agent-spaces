import type {
  InvocationCapabilities,
  InvocationEventEnvelope,
  HarnessInvocationSpec,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
} from 'spaces-harness-broker-protocol'

export interface Driver {
  readonly kind: string
  readonly version: string
  capabilities(): InvocationCapabilities
  start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>
  input(req: InvocationInputRequest): Promise<InvocationInputResponse>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  dispose(): Promise<void>
}

export interface DriverContext {
  invocationId: string
  emit(event: InvocationEventEnvelope): void
}

export interface DriverStartResult {
  ok: true
}
