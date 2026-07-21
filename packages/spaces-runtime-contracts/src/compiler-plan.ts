import type { InvocationResponseFormat } from 'spaces-harness-broker-protocol'
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
import type {
  CompileId,
  PlanHash,
  ProfileId,
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
    /**
     * Explicit controller selection for interactive routes. The compiler
     * discriminates terminal-vs-broker selection by this intent, NOT by catalog
     * array order. When set to 'foreground-terminal', the compiler selects the
     * foreground TerminalExecutionProfile. When omitted, the pre-HRC default
     * selects the harness-broker (claude-code-tmux for the claude-code family).
     */
    controllerIntent?: 'foreground-terminal' | undefined
  }

  materialization: {
    initialPrompt?: string | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    resolvedBundleHint?: ResolvedRuntimeBundle | undefined
    /**
     * Optional per-turn structured final response format (T-03779). Threaded
     * onto the compiled broker initial input so the public compile path and its
     * hashes exercise the feature. Response format alone never creates a turn.
     */
    responseFormat?: InvocationResponseFormat | undefined
  }

  hrcPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
    observability?: RuntimeObservabilityInput | undefined
    capabilityPolicy?: HrcCapabilityPolicy | undefined
    /**
     * Selected-harness tool identifiers the caller asks the chosen driver to
     * deny before tool execution. These are NOT portable platform tool ids
     * (`AskUserQuestion` is a Claude tool name, for example). The compiler does
     * not supply a default; absence preserves the selected harness' normal tool
     * surface.
     */
    disallowedTools?: string[] | undefined
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

export type CompiledAgentPolicy = {
  placement?: {
    defaultHomeNode?: string | undefined
    pins: Record<string, string>
    taskDefaults?: Record<string, string> | undefined
  }
  claimsTask: boolean
}

export type CompiledRuntimePlan = {
  schemaVersion: 'agent-runtime-plan/v1'
  compiler: {
    name: 'agent-spaces'
    version: string
  }
  compileId: CompileId
  planHash: PlanHash
  createdAt: IsoTimestamp

  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  agentPolicy?: CompiledAgentPolicy | undefined
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

  lockedEnv: {
    lockedEnvKeys: string[]
  }

  diagnostics: CompileDiagnostic[]
}

export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  profileId?: ProfileId | undefined
  details?: unknown
}
