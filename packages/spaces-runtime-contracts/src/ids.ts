import type { Id } from 'spaces-harness-broker-protocol'

export type {
  Id,
  InputId,
  InvocationId,
  MessageId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'

export type RequestId = Id<'request'>
export type CompileId = Id<'compile'>
export type PlanHash = string
export type RedactedPlanHash = string
export type ProfileId = Id<'profile'>
export type ProfileHash = string
export type CompatibilityHash = string
export type SpecHash = string
export type RedactedSpecHash = string
export type StartRequestHash = string
export type RedactedStartRequestHash = string
export type ArtifactId = Id<'artifact'>
export type ArtifactHash = string

export type HostSessionId = Id<'hostSession'>
export type RuntimeId = Id<'runtime'>
export type RuntimeOperationId = Id<'runtimeOperation'>
export type RunId = Id<'run'>
export type TraceId = Id<'trace'>
export type ServerInstanceId = Id<'serverInstance'>

import type { InputId, InvocationId } from 'spaces-harness-broker-protocol'

export type RuntimeIdentityAllocation = {
  requestId: RequestId
  operationId: RuntimeOperationId
  hostSessionId: HostSessionId
  generation: number
  runtimeId: RuntimeId
  invocationId?: InvocationId | undefined
  initialInputId?: InputId | undefined
  runId?: RunId | undefined
  traceId?: TraceId | undefined
  idempotencyKey?: string | undefined
}

export type RuntimeCorrelation = {
  requestId: RequestId
  operationId?: RuntimeOperationId | undefined
  hostSessionId: HostSessionId
  generation: number
  runtimeId?: RuntimeId | undefined
  runId?: RunId | undefined
  invocationId?: InvocationId | undefined
  traceId?: TraceId | undefined
  appId?: string | undefined
  appSessionKey?: string | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
}
