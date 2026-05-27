import type {
  BrokerCapabilities,
  ClientCapabilities,
  DriverSummary,
  InvocationCapabilities,
} from './capabilities'
import type { ContinuationUpdate } from './events'
import type { InputId, InvocationId, PermissionRequestId, TurnId } from './ids'
import type { HarnessInvocationSpec } from './invocation'
import type { JsonRpcRequest } from './jsonrpc'

export type BrokerMethodV1 =
  | 'broker.hello'
  | 'broker.health'
  | 'invocation.start'
  | 'invocation.input'
  | 'invocation.interrupt'
  | 'invocation.stop'
  | 'invocation.status'
  | 'invocation.dispose'

export type BrokerMethodV2 =
  | BrokerMethodV1
  | 'broker.attach'
  | 'broker.listInvocations'
  | 'invocation.eventsSince'
  | 'invocation.ackEvents'
  | 'invocation.snapshot'
  | 'invocation.permission.respond'

export type BrokerMethod = BrokerMethodV1

export type BrokerToClientRequestMethod = 'invocation.permission.request'
export type BrokerNotificationMethod = 'invocation.event'

export type BrokerCommand =
  | JsonRpcRequest<'broker.hello', BrokerHelloRequest>
  | JsonRpcRequest<'broker.health', BrokerHealthRequest>
  | JsonRpcRequest<'invocation.start', InvocationDispatchRequest>
  | JsonRpcRequest<'invocation.input', InvocationInputRequest>
  | JsonRpcRequest<'invocation.interrupt', InvocationInterruptRequest>
  | JsonRpcRequest<'invocation.stop', InvocationStopRequest>
  | JsonRpcRequest<'invocation.status', InvocationStatusRequest>
  | JsonRpcRequest<'invocation.dispose', InvocationDisposeRequest>

export interface BrokerHelloRequest {
  clientInfo: {
    name: string
    version?: string | undefined
  }
  protocolVersions: string[]
  capabilities?: ClientCapabilities | undefined
}

export interface BrokerHelloResponse {
  brokerInfo: {
    name: 'harness-broker'
    version: string
  }
  protocolVersion: 'harness-broker/0.1'
  capabilities: BrokerCapabilities
  drivers: DriverSummary[]
}

export interface BrokerHealthRequest {
  probeDrivers?: boolean | undefined
}

export interface BrokerHealthResponse {
  status: 'ok' | 'degraded' | 'shutting_down'
  activeInvocations: number
  drivers?: DriverSummary[] | undefined
}

/**
 * Dispatch-time runtime overlay (spec §3.3). Carries per-operation runtime
 * allocations and handles supplied AFTER profile selection by the HRC runtime
 * control plane (or the pre-HRC harness stand-in). This is NOT part of the
 * compiled/hashed spec: the compiled profile carries launch INTENT only
 * (`brokerTerminal.host: 'tmux'`), never a concrete tmux server socket.
 */
export interface InvocationRuntimeContext {
  /** Pre-allocated tmux server socket owned by the runtime control plane. */
  tmux?:
    | {
        socketPath: string
      }
    | undefined
}

export interface InvocationStartRequest {
  spec: HarnessInvocationSpec
  initialInput?: InvocationInput | undefined
  /**
   * Dispatch-time runtime overlay. REQUIRED for `claude-code-tmux` dispatch
   * (the driver attaches to this runtime-owned tmux socket; it must not own the
   * tmux server). Absent for routes that need no runtime resource handles.
   */
  runtime?: InvocationRuntimeContext | undefined
}

export interface InvocationDispatchRequest {
  startRequest: InvocationStartRequest
  dispatchEnv?: Record<string, string> | undefined
}

export interface InvocationStartResponse {
  invocationId: InvocationId
  state: InvocationState
  capabilities: InvocationCapabilities
}

export type InvocationState =
  | 'starting'
  | 'ready'
  | 'turn_active'
  | 'stopping'
  | 'exited'
  | 'failed'
  | 'disposed'

export interface InvocationInputRequest {
  invocationId: InvocationId
  input: InvocationInput
  policy?: InputPolicy | undefined
}

export interface InvocationInput {
  inputId?: InputId | undefined
  kind: 'user' | 'steer' | 'append_context'
  content: InputContent[]
  metadata?: Record<string, string> | undefined
}

export type InputContent =
  | { type: 'text'; text: string }
  | { type: 'local_image'; path: string }
  | { type: 'file_ref'; path: string; mimeType?: string | undefined }

export interface InputPolicy {
  whenBusy: 'reject' | 'queue' | 'interrupt_then_apply'
  timeoutMs?: number | undefined
}

export interface InvocationInputResponse {
  inputId: InputId
  accepted: boolean
  disposition: 'started' | 'queued' | 'rejected'
  reason?: string | undefined
  turnId?: TurnId | undefined
}

export interface InvocationInterruptRequest {
  invocationId: InvocationId
  scope: 'turn' | 'invocation'
  reason?: string | undefined
  graceMs?: number | undefined
}

export interface InvocationInterruptResponse {
  accepted: boolean
  effect: 'turn_interrupted' | 'invocation_stopping' | 'unsupported' | 'no_active_turn'
  reason?: string | undefined
}

export interface InvocationStopRequest {
  invocationId: InvocationId
  reason?: string | undefined
  graceMs?: number | undefined
}

export interface InvocationStopResponse {
  accepted: boolean
  state: InvocationState
}

export interface InvocationStatusRequest {
  invocationId: InvocationId
}

export interface InvocationStatusResponse {
  invocationId: InvocationId
  state: InvocationState
  currentTurnId?: TurnId | undefined
  continuation?: ContinuationUpdate | undefined
  capabilities: InvocationCapabilities
  process?:
    | {
        pid?: number | undefined
        exitCode?: number | null | undefined
        signal?: string | null | undefined
      }
    | undefined
}

export interface InvocationDisposeRequest {
  invocationId: InvocationId
}

export interface InvocationDisposeResponse {
  disposed: true
}

export interface PermissionRequestParams {
  invocationId: InvocationId
  turnId?: TurnId | undefined
  permissionRequestId: PermissionRequestId
  kind: 'command' | 'file_change' | 'tool' | string
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  message?: string | undefined
}
