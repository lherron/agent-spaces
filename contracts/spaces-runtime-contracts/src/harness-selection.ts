import type {
  InvocationDispatchRequest,
  InvocationStartRequest,
  IsoTimestamp,
} from 'spaces-harness-broker-protocol'
import type { HrcCapabilityPolicy } from './capabilities'
import type { RuntimeContinuationRef } from './continuation'
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
import type { RuntimeResourceLimits } from './resources'

/** The complete, deliberately closed, public harness vocabulary. */
export type HarnessId = 'agent-harness' | 'claude' | 'codex' | 'muse'

export type ReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh'

/**
 * Selection input, intentionally independent from driver, terminal, and
 * hosting details. `presentation` is optional so an explicit false survives
 * property-preserving provisioning merges.
 */
export type HarnessSelectionRequest = {
  harness?: HarnessId | undefined
  modelProvider?: string | undefined
  model?: string | undefined
  reasoningEffort?: ReasoningEffort | undefined
  presentation?: boolean | undefined
}

/**
 * Raw per-summon selection directives. Directive spelling remains snake_case
 * so this layer cannot be confused with the higher-precedence explicit
 * `requested` overrides.
 */
export type HarnessSelectionDirectives = {
  harness?: HarnessId | undefined
  model_provider?: string | undefined
  model?: string | undefined
  reasoning_effort?: ReasoningEffort | undefined
  presentation?: boolean | undefined
}

/** A diagnostic emitted while resolving or compiling a v2 runtime plan. */
export type CompileDiagnostic = {
  level: 'info' | 'warning' | 'error'
  code: string
  message: string
  plane: 'asp-compiler'
  profileId?: ProfileId | undefined
  details?: unknown
}

export type RuntimeCompileRequest = {
  schemaVersion: 'agent-runtime-compile-request/v2'
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  selectionContext?: {
    summonDirectives?: HarnessSelectionDirectives | undefined
  }
  requested: HarnessSelectionRequest
  materialization: {
    initialPrompt?: string | undefined
    omitPriming?: boolean | undefined
    attachments?: AttachmentRef[] | undefined
    taskContext?: HrcTaskContext | undefined
    resolvedBundleHint?: ResolvedRuntimeBundle | undefined
    responseFormat?: import('spaces-harness-broker-protocol').InvocationResponseFormat | undefined
  }
  hrcPolicy: {
    permissionPolicy?: BrokerPermissionPolicy | undefined
    inputPolicy?: BrokerInputPolicy | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
    observability?: RuntimeObservabilityInput | undefined
    capabilityPolicy?: HrcCapabilityPolicy | undefined
    disallowedTools?: string[] | undefined
  }
  continuation?: RuntimeContinuationRef | undefined
  correlation: RuntimeCorrelation
}

export type SelectionProvenanceLayer =
  | 'catalog-default'
  | 'agent-profile'
  | 'project-target'
  | 'summon-directive'
  | 'compile-request'

export type SelectionProvenance = {
  harness: SelectionProvenanceLayer
  modelProvider: SelectionProvenanceLayer
  model: SelectionProvenanceLayer
  reasoningEffort?: SelectionProvenanceLayer | undefined
  presentation: SelectionProvenanceLayer
}

export type HostingRequirements = {
  executionTransport: 'jsonrpc-stdio' | 'pty' | 'native-worker'
  terminalRequired: boolean
  terminalHost?: 'tmux' | undefined
  processExecution: 'native-worker' | 'broker-process'
}

/** Presentation is a separate surface from the execution protocol transport. */
export type PresentationSurface =
  | { transport: 'terminal'; terminalHost: 'tmux' }
  | { transport: 'websocket-unix'; terminalHost: 'tmux' }

export type ResolvedHarnessSelection = {
  harness: HarnessId
  modelProvider: string
  model: string
  reasoningEffort?: ReasoningEffort | undefined
  presentation: boolean
  provenance: SelectionProvenance
}

export type ResolvedHosting = HostingRequirements

export type ExecutionRecipeDto = {
  recipeId: string
  driver: string
  protocol: 'harness-broker/0.2'
  hosting: HostingRequirements
  presentationSurface?: PresentationSurface | undefined
  presentationFulfillment: 'intrinsic' | 'attachable' | 'birth-variant'
}

export type ResolvedExecutionProfile = {
  profileId: string
  profileHash: string
  compatibilityHash: string
  startRequestHash: string
}

export type CompiledExecution = ExecutionRecipeDto & {
  profile: ResolvedExecutionProfile
  dispatchRequest: InvocationDispatchRequest
}

/** The v2 singular compiled-plan DTO. */
export type CompiledRuntimePlan = {
  schemaVersion: 'agent-runtime-plan/v2'
  compiler: { name: 'agent-spaces'; version: string }
  compileId: CompileId
  planHash: PlanHash
  createdAt: IsoTimestamp
  agent: { id: string }
  identity: RuntimeIdentityAllocation
  placement: RuntimePlacement
  resolvedBundle: ResolvedRuntimeBundle
  omitPriming: boolean
  selection: ResolvedHarnessSelection
  execution: CompiledExecution
  artifacts: {
    materializedBundleRoot?: string | undefined
    systemPromptFile?: string | undefined
    userPromptFile?: string | undefined
    lockHash?: string | undefined
    bundleIdentity: string
  }
  lockedEnv: { lockedEnvKeys: string[] }
  diagnostics: CompileDiagnostic[]
}

export type RuntimeCompileResponse =
  | {
      schemaVersion: 'agent-runtime-compile-response/v2'
      ok: true
      plan: CompiledRuntimePlan
      diagnostics: CompileDiagnostic[]
      effectiveEnvironmentHash?: string | undefined
    }
  | {
      schemaVersion: 'agent-runtime-compile-response/v2'
      ok: false
      diagnostics: CompileDiagnostic[]
    }

/** Canonical dispatch request is carried exactly once by the compiled execution. */
export type CanonicalDispatchStartRequest = InvocationStartRequest
