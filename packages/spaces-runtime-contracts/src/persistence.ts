import type {
  InvocationEventType,
  InvocationId,
  InvocationState,
} from 'spaces-harness-broker-protocol'
import type {
  ArtifactHash,
  ArtifactId,
  CompileId,
  HostSessionId,
  PlanHash,
  ProfileHash,
  ProfileId,
  RedactedPlanHash,
  RedactedSpecHash,
  RedactedStartRequestHash,
  RunId,
  RuntimeId,
  RuntimeOperationId,
  ServerInstanceId,
  SpecHash,
  StartRequestHash,
} from './ids'
import type { RuntimeOperationKind, RuntimeOperationStatus } from './operations'
import type { RuntimeControllerKind } from './primitives'
import type { IsoTimestamp } from './primitives'
import type { RedactionState } from './redaction'

export type CompiledRuntimePlanRecord = {
  planHash: PlanHash
  compileId: CompileId
  schemaVersion: 'agent-runtime-plan/v1'
  compilerName: 'agent-spaces'
  compilerVersion: string
  redactedPlanHash: RedactedPlanHash
  redactedPlanJson: string
  diagnosticsJson?: string | undefined
  createdAt: IsoTimestamp
}

export type RuntimeOperationRecord = {
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
  routeDecisionJson: string
  capabilityResolutionJson?: string | undefined
  createdAt: IsoTimestamp
  startedAt?: IsoTimestamp | undefined
  completedAt?: IsoTimestamp | undefined
  updatedAt: IsoTimestamp
  errorCode?: string | undefined
  errorMessage?: string | undefined
}

export type BrokerInvocationRecord = {
  invocationId: InvocationId
  operationId: RuntimeOperationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: string
  brokerPid?: number | undefined
  childPid?: number | undefined
  invocationState: InvocationState
  capabilitiesJson: string
  continuationJson?: string | undefined
  brokerContinuationJson?: string | undefined
  specHash: SpecHash
  redactedSpecHash?: RedactedSpecHash | undefined
  startRequestHash: StartRequestHash
  redactedStartRequestHash?: RedactedStartRequestHash | undefined
  selectedProfileHash: ProfileHash
  redactedSpecJson?: string | undefined
  redactedStartRequestJson?: string | undefined
  lastEventSeq?: number | undefined
  ownerServerInstanceId?: ServerInstanceId | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type BrokerInvocationEventRecord = {
  invocationId: InvocationId
  seq: number
  time: IsoTimestamp
  type: InvocationEventType
  runId?: RunId | undefined
  runtimeId: RuntimeId
  brokerEventJson: string
  hrcEventSeq?: number | undefined
  projectionStatus: 'pending' | 'applied' | 'duplicate' | 'failed'
  projectionError?: string | undefined
  createdAt: IsoTimestamp
}

export type RuntimeArtifactRecord = {
  artifactId: ArtifactId
  operationId: RuntimeOperationId
  artifactKind:
    | 'compiled-plan'
    | 'execution-profile'
    | 'broker-spec'
    | 'broker-start-request'
    | 'prompt'
    | 'diagnostics'
    | string
  mediaType: 'application/json' | 'text/plain' | string
  storageKind: 'inline-json' | 'file-path'
  contentHash: ArtifactHash
  redactionState: RedactionState
  artifactJson?: string | undefined
  artifactPath?: string | undefined
  createdAt: IsoTimestamp
}
