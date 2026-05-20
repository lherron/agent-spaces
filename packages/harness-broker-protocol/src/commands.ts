import type {
  BrokerCapabilities,
  ClientCapabilities,
  DriverSummary,
  InvocationCapabilities,
} from './capabilities'
import type { ContinuationUpdate } from './events'
import type { HarnessInvocationSpec } from './invocation'
import type { JsonRpcRequest } from './jsonrpc'

export type BrokerMethod =
  | 'broker.hello'
  | 'broker.health'
  | 'invocation.start'
  | 'invocation.input'
  | 'invocation.interrupt'
  | 'invocation.stop'
  | 'invocation.status'
  | 'invocation.dispose'

export type BrokerCommand =
  | JsonRpcRequest<'broker.hello', BrokerHelloRequest>
  | JsonRpcRequest<'broker.health', BrokerHealthRequest>
  | JsonRpcRequest<'invocation.start', InvocationStartRequest>
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

export interface InvocationStartRequest {
  spec: HarnessInvocationSpec
  initialInput?: InvocationInput | undefined
}

export interface InvocationStartResponse {
  invocationId: string
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
  invocationId: string
  input: InvocationInput
  policy?: InputPolicy | undefined
}

export interface InvocationInput {
  inputId?: string | undefined
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
  inputId: string
  accepted: boolean
  disposition: 'started' | 'queued' | 'rejected'
  reason?: string | undefined
  turnId?: string | undefined
}

export interface InvocationInterruptRequest {
  invocationId: string
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
  invocationId: string
  reason?: string | undefined
  graceMs?: number | undefined
}

export interface InvocationStopResponse {
  accepted: boolean
  state: InvocationState
}

export interface InvocationStatusRequest {
  invocationId: string
}

export interface InvocationStatusResponse {
  invocationId: string
  state: InvocationState
  currentTurnId?: string | undefined
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
  invocationId: string
}

export interface InvocationDisposeResponse {
  disposed: true
}

export interface PermissionRequestParams {
  invocationId: string
  turnId?: string | undefined
  permissionRequestId: string
  kind: 'command' | 'file_change' | 'tool' | string
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
}

export interface PermissionDecision {
  decision: 'allow' | 'deny'
  message?: string | undefined
}
