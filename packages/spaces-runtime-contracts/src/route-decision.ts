import type { CapabilityResolution, HrcCapabilityPolicy } from './capabilities'
import type { CompiledRuntimePlan } from './compiler-plan'
import type { AgentchatExposurePolicy } from './exposure'
import type { AttachmentRef, HrcTaskContext, RuntimePlacement } from './external'
import type {
  CompatibilityHash,
  CompileId,
  PlanHash,
  ProfileHash,
  ProfileId,
  RuntimeId,
  RuntimeOperationId,
} from './ids'
import type { BrokerInputPolicy } from './input'
import type { HrcRuntimeSnapshot } from './operations'
import type { BrokerPermissionPolicy } from './permissions'
import type {
  HarnessRuntime,
  InteractionMode,
  IsoTimestamp,
  LegacyTransportAlias,
  ProviderDomain,
  RuntimeControllerKind,
  RuntimeExecutionProfileKind,
} from './primitives'
import type { RuntimeResourceLimits } from './resources'

export type HrcRuntimeIntent = {
  placement: RuntimePlacement
  harness: {
    provider: ProviderDomain
    interactive: boolean
    id?: 'agent-sdk' | 'claude-code' | 'codex-cli' | 'pi' | 'pi-cli' | 'pi-sdk' | undefined
    fallback?: string | undefined
    model?: string | undefined
    yolo?: boolean | undefined
  }
  execution?:
    | {
        preferredMode?: InteractionMode | undefined
        autoLaunchInteractive?: boolean | undefined
        allowFallback?: boolean | undefined
      }
    | undefined
  launch?:
    | {
        env?: Record<string, string> | undefined
        unsetEnv?: string[] | undefined
        pathPrepend?: string[] | undefined
      }
    | undefined
  initialPrompt?: string | undefined
  attachments?: AttachmentRef[] | undefined
  taskContext?: HrcTaskContext | undefined
}

export type HrcRoutePolicy = {
  codexHeadlessDefaultController: 'harness-broker' | 'legacy-exec'
  allowLegacyExec: boolean
  allowSilentFallback: false
  staleGeneration: 'rotate' | 'allow'
  reuse: 'reuse-compatible' | 'always-new' | 'adopt-existing'
  capabilityPolicy: HrcCapabilityPolicy
}

export type RuntimeRouteInput = {
  intent: HrcRuntimeIntent
  compiledPlan: CompiledRuntimePlan
  existingRuntime?: HrcRuntimeSnapshot | undefined
  requestPolicy: HrcRoutePolicy
  now: IsoTimestamp
}

export type RuntimeRouteDecision = {
  schemaVersion: 'hrc-route-decision/v1'
  routeId: string
  operationId: RuntimeOperationId
  compileId: CompileId
  planHash: PlanHash

  selectedProfileId: ProfileId
  selectedProfileHash: ProfileHash
  selectedProfileKind: RuntimeExecutionProfileKind
  controller: RuntimeControllerKind

  admission: { decision: 'admit' } | { decision: 'reject'; reason: string; code: string }

  reuse: {
    policy: 'reuse-compatible' | 'always-new' | 'adopt-existing'
    compatibilityHash: CompatibilityHash
    staleGeneration: 'rotate' | 'allow'
    existingRuntimeId?: RuntimeId | undefined
  }

  productPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }

  capabilities: CapabilityResolution
  legacyTransportAlias: LegacyTransportAlias

  diagnostics?:
    | Array<{
        level: 'info' | 'warning' | 'error'
        code: string
        message: string
      }>
    | undefined
}

export type RuntimeRouteHarnessRuntime = HarnessRuntime | string
