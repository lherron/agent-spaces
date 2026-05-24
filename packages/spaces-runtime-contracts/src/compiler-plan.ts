import type { HrcCapabilityPolicy } from './capabilities'
import type { RuntimeContinuationRef } from './continuation'
import type { RuntimeExecutionProfile } from './execution-profile'
import type { AgentchatExposurePolicy } from './exposure'
import type {
  AttachmentRef,
  HrcTaskContext,
  ResolvedRuntimeBundle,
  RuntimePlacement,
} from './external'
import type { SecretDigest } from './hash'
import type {
  CompileId,
  PlanHash,
  ProfileId,
  RedactedPlanHash,
  RuntimeCorrelation,
  RuntimeIdentityAllocation,
} from './ids'
import type { BrokerInputPolicy } from './input'
import type { RuntimeObservabilityInput } from './observability'
import type { BrokerPermissionPolicy } from './permissions'
import type {
  HarnessFamily,
  HarnessRuntime,
  InteractionMode,
  IsoTimestamp,
  ProviderDomain,
} from './primitives'
import type { RuntimeResourceLimits } from './resources'

export type RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v1'
  identity: RuntimeIdentityAllocation

  placement: RuntimePlacement

  requested: {
    modelProvider?: ProviderDomain | undefined
    model?: string | undefined
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
    harnessFamily?: HarnessFamily | undefined
    preferredHarnessRuntime?: HarnessRuntime | undefined
    interactionMode?: InteractionMode | undefined
  }

  materialization: {
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    resolvedBundleHint?: ResolvedRuntimeBundle | undefined
  }

  hrcPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
    observability?: RuntimeObservabilityInput | undefined
    capabilityPolicy?: HrcCapabilityPolicy | undefined
  }

  continuation?: RuntimeContinuationRef | undefined
  correlation: RuntimeCorrelation
}

export type RuntimeCompileResponse =
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: true
      plan: CompiledRuntimePlan
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: 'agent-runtime-compile-response/v1'
      ok: false
      diagnostics: CompileDiagnostic[]
    }

export type CompiledRuntimePlan = {
  schemaVersion: 'agent-runtime-plan/v1'
  compiler: {
    name: 'agent-spaces'
    version: string
  }
  compileId: CompileId
  planHash: PlanHash
  redactedPlanHash: RedactedPlanHash
  createdAt: IsoTimestamp

  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  resolvedBundle: ResolvedRuntimeBundle

  harness: {
    family: HarnessFamily
    runtime: HarnessRuntime
    provider: ProviderDomain
  }

  model: {
    provider: ProviderDomain
    modelId: string
    requestedModel?: string | undefined
    reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | undefined
  }

  executionProfiles: RuntimeExecutionProfile[]

  artifacts: {
    materializedBundleRoot?: string | undefined
    systemPromptFile?: string | undefined
    userPromptFile?: string | undefined
    lockHash?: string | undefined
    bundleIdentity: string
  }

  secrets: {
    envKeys: string[]
    secretEnvKeys: string[]
    secretDigests?: Record<string, SecretDigest> | undefined
  }

  diagnostics: CompileDiagnostic[]
}

export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  profileId?: ProfileId | undefined
  redactedDetails?: unknown
}
