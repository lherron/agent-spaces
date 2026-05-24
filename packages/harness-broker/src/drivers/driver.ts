import type {
  ClientCapabilities,
  HarnessInvocationSpec,
  InputId,
  InvocationCapabilities,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationId,
  InvocationInput,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  PermissionDecision,
  PermissionRequestParams,
  TurnId,
} from 'spaces-harness-broker-protocol'

export interface ApplyInputResult {
  turnId?: TurnId | undefined
}

export interface Driver {
  readonly kind: string
  readonly version: string
  capabilities(): InvocationCapabilities
  start(spec: HarnessInvocationSpec, ctx: DriverContext): Promise<DriverStartResult>
  applyInputNow(input: InvocationInput): Promise<ApplyInputResult>
  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse>
  stop(req: InvocationStopRequest): Promise<InvocationStopResponse>
  dispose(): Promise<void>
}

export interface DriverContext {
  invocationId: InvocationId
  clientCapabilities: ClientCapabilities
  emit<TPayload>(
    type: InvocationEventType,
    payload: TPayload,
    extra?: {
      turnId?: TurnId | undefined
      inputId?: InputId | undefined
      itemId?: string | undefined
      driver?: { kind: string; rawType?: string | undefined } | undefined
    }
  ): InvocationEventEnvelope<TPayload>
  /**
   * Ask the connected client to decide a permission request via the
   * broker→client JSON-RPC request transport. Provided only when the broker
   * has a transport that supports outbound requests (and, in production, when
   * the client negotiated `permissionRequests`). Absent for in-process callers
   * that have no client to ask.
   */
  requestPermission?(params: PermissionRequestParams): Promise<PermissionDecision>
}

export interface DriverStartResult {
  ok: true
}
