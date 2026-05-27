import type { InvocationId } from 'spaces-harness-broker-protocol'
import type { RuntimeCapabilities } from './capabilities'
import type { RuntimeContinuationRef } from './continuation'
import type {
  CompileId,
  HostSessionId,
  PlanHash,
  ProfileHash,
  ProfileId,
  RunId,
  RuntimeId,
  RuntimeOperationId,
} from './ids'
import type {
  HarnessFamily,
  HarnessRuntime,
  InteractionMode,
  IsoTimestamp,
  LegacyTransportAlias,
  ProviderDomain,
  RunStatus,
  RuntimeControllerKind,
  RuntimeStatus,
} from './primitives'
import type { RuntimeRouteDecision } from './route-decision'
import type { RuntimeState } from './runtime-state'

export type RuntimeOperationKind =
  | 'terminal_launch'
  | 'broker_invocation'
  | 'broker_input'
  | 'sdk_turn'
  | 'command_process'
  | 'legacy_exec'
  | 'interrupt'
  | 'stop'
  | 'dispose'
  | 'reconcile'

export type RuntimeOperationStatus =
  | 'accepted'
  | 'admitted'
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'rejected'

export type RuntimeOperation = {
  schemaVersion: 'runtime-operation/v1'
  operationId: RuntimeOperationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  hostSessionId: HostSessionId
  generation: number
  operationKind: RuntimeOperationKind
  controller: RuntimeControllerKind
  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileId?: ProfileId | undefined
  selectedProfileHash?: ProfileHash | undefined
  startupMethod: string
  turnDelivery?: string | undefined
  status: RuntimeOperationStatus
  routeDecision: RuntimeRouteDecision
  createdAt: IsoTimestamp
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type RuntimeInputEnvelope = {
  inputId: InputId
  runId?: RunId | undefined
  kind: 'user' | 'steer' | 'append_context'
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'local_image'; path: string }
    | { type: 'file_ref'; path: string; mimeType?: string | undefined }
  >
  metadata?: Record<string, string> | undefined
}

import type { InputId } from 'spaces-harness-broker-protocol'

export type HrcRuntimeSnapshot = {
  runtimeId: RuntimeId
  runtimeKind?: 'harness' | 'command' | undefined
  hostSessionId: HostSessionId
  scopeRef: string
  laneRef: string
  generation: number

  controller: RuntimeControllerKind
  interactionMode: InteractionMode
  harnessFamily?: HarnessFamily | undefined
  harnessRuntime?: HarnessRuntime | string | undefined
  provider: ProviderDomain
  modelProvider?: ProviderDomain | undefined

  status: RuntimeStatus
  runtimeState?: RuntimeState | undefined

  compileId?: CompileId | undefined
  planHash?: PlanHash | undefined
  selectedProfileHash?: ProfileHash | undefined
  routeDecision?: RuntimeRouteDecision | undefined

  continuation?: RuntimeContinuationRef | undefined
  capabilities: RuntimeCapabilities
  supportsInflightInput: boolean

  activeOperationId?: RuntimeOperationId | undefined
  activeInvocationId?: InvocationId | undefined
  activeRunId?: RunId | undefined

  legacyTransport: LegacyTransportAlias
  transport: LegacyTransportAlias
  launchId?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined

  adopted: boolean
  lastActivityAt?: IsoTimestamp | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type HrcRunRecord = {
  runId: RunId
  hostSessionId: HostSessionId
  runtimeId?: RuntimeId | undefined
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  scopeRef: string
  laneRef: string
  generation: number
  controller: RuntimeControllerKind
  transport: LegacyTransportAlias
  status: RunStatus
  acceptedAt?: IsoTimestamp | undefined
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type HrcEventEnvelope = {
  seq: number
  streamSeq: number
  ts: IsoTimestamp
  hostSessionId: HostSessionId
  scopeRef: string
  laneRef: string
  generation: number
  runId?: RunId | undefined
  runtimeId?: RuntimeId | undefined
  operationId?: RuntimeOperationId | undefined
  invocationId?: InvocationId | undefined
  source: 'agent-spaces' | 'broker' | 'hook' | 'hrc' | 'otel' | 'tmux'
  eventKind: string
  eventJson: unknown
}
