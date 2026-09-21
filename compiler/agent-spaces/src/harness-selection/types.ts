import type {
  HarnessId,
  HarnessSelectionRequest,
  HostingRequirements,
  ProviderDomain,
  ReasoningEffort,
  ResolvedHarnessSelection,
} from 'spaces-runtime-contracts'

export type BuilderId =
  | 'agent-harness'
  | 'agent-harness-tmux'
  | 'claude-code-tmux'
  | 'codex-app-server'
  | 'muse-serve'
  | 'muse-cli-tmux'

export type PresentationFulfillment = 'intrinsic' | 'attachable' | 'birth-variant' | 'unsupported'

export type ProviderDefinition = {
  id: string
  defaultModel: string
  supportedModels: readonly string[]
}

export type ExecutionRecipe = {
  recipeId: string
  builder: BuilderId
  driver: string
  protocol: 'harness-broker/0.2'
  hosting: HostingRequirements
  presentationSurface?: import('spaces-runtime-contracts').PresentationSurface | undefined
  presentationFulfillment: PresentationFulfillment
}

export type ExplicitRefusal = {
  code: 'presentation_unavailable'
  message: string
}

/**
 * A concrete process implementation emitted only after canonical harness
 * selection. It is deliberately catalog data rather than a caller-facing
 * selection vocabulary.
 */
export type ProcessImplementation = {
  frontend: 'claude-code' | 'codex-cli' | 'muse-cli'
  provider: ProviderDomain
}

export type HarnessDefinition = {
  id: HarnessId
  defaultModelProvider: string
  supportedModelProviders: readonly ProviderDefinition[]
  presentationDefault: boolean
  executionVariants: {
    withoutPresentation: ExecutionRecipe
    withPresentation: ExecutionRecipe | ExplicitRefusal
  }
  processImplementation?: ProcessImplementation | undefined
}

export type ProvisioningLayer = Partial<HarnessSelectionRequest>

export type ProvisioningLayers = {
  agentProfile?: ProvisioningLayer | undefined
  projectTarget?: ProvisioningLayer | undefined
  summonDirectives?: ProvisioningLayer | undefined
}

export type SelectionConsistencyInputs = {
  /** Explicit canonical identities gathered by the request boundary. */
  agentIds?: readonly string[] | undefined
}

export type ResolveHarnessExecutionInput = {
  agent: { id: string }
  provisioningLayers?: ProvisioningLayers | undefined
  requested?: ProvisioningLayer | undefined
  /** Reserved for capability admission; it never changes catalog selection. */
  runtimeCapabilities?: unknown
  consistency?: SelectionConsistencyInputs | undefined
}

export type CompileRefusalCode =
  | 'configured_context_mismatch'
  | 'unsupported_harness'
  | 'unsupported_model_provider'
  | 'unsupported_model'
  | 'presentation_unavailable'

export type CompileRefusal = {
  ok: false
  code: CompileRefusalCode
  message: string
  details?: Record<string, unknown> | undefined
}

export type ResolvedHarnessExecution = {
  ok: true
  selection: ResolvedHarnessSelection
  recipe: ExecutionRecipe
}

export type HarnessResolution = ResolvedHarnessExecution | CompileRefusal

export type ResolvedScalar<T> = {
  value: T
  source: import('spaces-runtime-contracts').SelectionProvenanceLayer
}
export type ResolvedReasoningEffort = ResolvedScalar<ReasoningEffort> | undefined
