import type { RuntimeCapabilities } from './capabilities'
import type { RuntimeContinuationRef } from './continuation'
import type {
  RuntimeDispatchResult,
  RuntimeDisposeResult,
  RuntimeInterruptResult,
  RuntimeReconcileResult,
  RuntimeStopResult,
} from './controller'
import type { AttachmentRef } from './external'
import type {
  CompileId,
  HostSessionId,
  InvocationId,
  PermissionRequestId,
  PlanHash,
  ProfileHash,
  RunId,
  RuntimeId,
  RuntimeOperationId,
} from './ids'
import type { HrcRuntimeSnapshot, RuntimeInputEnvelope, RuntimeOperation } from './operations'
import type { BrokerPermissionDecisionRecord } from './permissions'
import type { BrokerInvocationRecord } from './persistence'
import type {
  HarnessFamily,
  HarnessRuntime,
  InteractionMode,
  LegacyTransportAlias,
  ProviderDomain,
  RuntimeControllerKind,
  RuntimeStatus,
} from './primitives'
import type { HrcRuntimeIntent } from './route-decision'
import type { RuntimeState } from './runtime-state'

export type RuntimeExecutionView = {
  schemaVersion: 'runtime-public-view/v1'
  runtimeId: RuntimeId
  hostSessionId: HostSessionId
  generation: number
  status: RuntimeStatus

  controller:
    | { kind: 'terminal'; terminalHost: 'tmux' | 'ghostty' }
    | { kind: 'embedded-sdk' }
    | { kind: 'harness-broker'; brokerDriver: string; brokerProtocol: 'harness-broker/0.1' }
    | { kind: 'command-process' }
    | { kind: 'legacy-exec'; migrationOnly: true }

  harness?:
    | {
        family: HarnessFamily
        runtime: HarnessRuntime | string
        provider: ProviderDomain
      }
    | undefined

  interactionMode: InteractionMode
  startupMethod: string
  turnDelivery: string
  capabilities: RuntimeCapabilities

  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileHash?: ProfileHash | undefined
  activeOperationId?: RuntimeOperationId | undefined
  activeInvocationId?: InvocationId | undefined

  transport: LegacyTransportAlias
  supportsInFlightInput: boolean
}

export function legacyTransportAlias(view: RuntimeExecutionView): LegacyTransportAlias {
  switch (view.controller.kind) {
    case 'terminal':
      return 'tmux'
    case 'embedded-sdk':
      return 'sdk'
    case 'harness-broker':
    case 'command-process':
    case 'legacy-exec':
      return 'headless'
  }
}

export type EnsureRuntimeRequest = {
  hostSessionId: HostSessionId
  intent: HrcRuntimeIntent
  restartStyle?: 'reuse_pty' | 'fresh_pty' | undefined
  allowStaleGeneration?: boolean | undefined
}

export type EnsureRuntimeResponse = RuntimeExecutionView
export type StartRuntimeRequest = EnsureRuntimeRequest
export type StartRuntimeResponse = RuntimeExecutionView

export type DispatchTurnRequest = {
  hostSessionId: HostSessionId
  prompt: string
  attachments?: AttachmentRef[] | undefined
  runtimeIntent?: HrcRuntimeIntent | undefined
  waitForCompletion?: boolean | undefined
  allowStaleGeneration?: boolean | undefined
  idempotencyKey?: string | undefined
}

export type DispatchTurnResponse = {
  runId: RunId
  hostSessionId: HostSessionId
  generation: number
  runtimeId: RuntimeId
  controller: RuntimeControllerKind
  transport: LegacyTransportAlias
  status: 'completed' | 'started' | 'queued' | 'rejected'
  supportsInFlightInput: boolean
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  inputDisposition?: 'started' | 'queued' | 'rejected' | undefined
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type RuntimeInputRequest = {
  runtimeId: RuntimeId
  runId?: RunId | undefined
  input: RuntimeInputEnvelope
  idempotencyKey?: string | undefined
}

export type RuntimeInputResponse = RuntimeDispatchResult

export type InterruptRuntimeRequest = {
  runtimeId: RuntimeId
  scope?: 'turn' | 'runtime' | undefined
  reason?: string | undefined
  hard?: boolean | undefined
}

export type InterruptRuntimeResponse = RuntimeInterruptResult

export type StopRuntimeRequest = {
  runtimeId: RuntimeId
  reason?: string | undefined
  graceMs?: number | undefined
  dropContinuation?: boolean | undefined
}

export type StopRuntimeResponse = RuntimeStopResult

export type DisposeRuntimeRequest = {
  runtimeId: RuntimeId
}

export type DisposeRuntimeResponse = RuntimeDisposeResult

export type InspectRuntimeRequest = {
  runtimeId: RuntimeId
}

export type InspectRuntimeResponse = RuntimeExecutionView & {
  runtimeState: RuntimeState
  activeOperation?: RuntimeOperation | undefined
  activeInvocation?: BrokerInvocationRecord | undefined
  continuation?: RuntimeContinuationRef | undefined
  continuationStale?: boolean | undefined
}

export type ListRuntimesRequest = {
  hostSessionId?: HostSessionId | undefined
  controller?: RuntimeControllerKind | undefined
  status?: RuntimeStatus[] | undefined
  limit?: number | undefined
}

export type ListRuntimesResponse = RuntimeExecutionView[]

export type ReconcileRuntimesRequest = {
  runtimeId?: RuntimeId | undefined
  controller?: RuntimeControllerKind | undefined
  dryRun?: boolean | undefined
}

export type ReconcileRuntimesResponse = {
  ok: true
  results: Array<{
    runtimeId: RuntimeId
    result: RuntimeReconcileResult
  }>
}

export type PermissionRespondRequest = {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  message?: string | undefined
}

export type PermissionRespondResponse = {
  ok: true
  record: BrokerPermissionDecisionRecord
}

export type RuntimePublicSnapshot = HrcRuntimeSnapshot
