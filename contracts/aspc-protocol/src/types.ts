import type {
  AspReleaseIdentity,
  BrokerLifecyclePolicyOverlay,
  BrokerProtocolVersion,
  InvocationDispatchRequest,
  InvocationRuntimeContext,
  InvocationStartRequest,
  InvocationStartResponse,
  JsonRpcRequest,
} from 'spaces-harness-broker-protocol'
import type {
  AgentInspectionEvaluationContext,
  AgentInspectionRequest,
  AgentInspectionResult,
  BrokerExecutionProfile,
  BuildProcessInvocationSpecResponse,
  CompileContext,
  CompileDiagnostic,
  ProcessAttachmentRef,
  RuntimePlacement,
} from 'spaces-runtime-contracts'
import type {
  LegacyCompiledRuntimePlan as CompiledRuntimePlan,
  LegacyRuntimeCompileRequest as RuntimeCompileRequest,
  LegacyRuntimeCompileResponse as RuntimeCompileResponse,
} from 'spaces-runtime-contracts/internal/compiler-plan-v1'
import type {
  AspcCatalogAgentInspectionRequest,
  AspcInspectAgentSelectionRequest,
} from './agent-inspection-types.js'

export type * from './agent-inspection-types.js'

export const ASPC_PROTOCOL_VERSION = 'aspc/0.1' as const

export type AspcProtocolVersion = typeof ASPC_PROTOCOL_VERSION

/**
 * `schemaVersion` discriminators for ASPC response envelopes. Named here so the
 * literals are not copy-pasted across the success/failure branches of each
 * response union below.
 */
export const ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION =
  'aspc-compile-harness-invocation-response/v1' as const
export const ASPC_COMPILE_AND_START_RESPONSE_VERSION = 'aspc-compile-and-start-response/v1' as const
export const ASPC_RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION =
  'aspc-resolve-runtime-declaration-response/v1' as const
export const ASPC_INSPECT_RUNTIME_PLACEMENT_RESPONSE_VERSION =
  'aspc-inspect-runtime-placement-response/v1' as const
export const ASPC_OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION =
  'aspc-observe-runtime-capability-response/v1' as const
export const ASPC_OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION =
  'aspc-observe-continuation-artifact-response/v1' as const
export const ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION =
  'aspc-prepare-process-invocation-response/v1' as const

/**
 * Single source of truth for the set of `aspc.*` methods. `AspcMethod`, the
 * runtime predicate, and the validator dispatch table are all derived from this
 * tuple so a new method cannot drift out of sync across those surfaces.
 */
export const ASPC_METHODS = [
  'aspc.hello',
  'aspc.compileRuntimePlan',
  'aspc.catalogAgents',
  'aspc.inspectAgent',
  'aspc.catalogAgentInspection',
  'aspc.inspectAgentSelection',
  'aspc.compileHarnessInvocation',
  'aspc.resolveRuntimeDeclaration',
  'aspc.inspectRuntimePlacement',
  'aspc.observeRuntimeCapability',
  'aspc.observeContinuationArtifact',
  'aspc.prepareProcessInvocation',
  'aspc.compileAndStart',
] as const

export type AspcMethod = (typeof ASPC_METHODS)[number]

export type AspcCommand =
  | JsonRpcRequest<'aspc.hello', AspcHelloRequest>
  | JsonRpcRequest<'aspc.compileRuntimePlan', AspcCompileRuntimePlanRequest>
  | JsonRpcRequest<'aspc.catalogAgents', AspcCatalogAgentsRequest>
  | JsonRpcRequest<'aspc.inspectAgent', AspcInspectAgentRequest>
  | JsonRpcRequest<'aspc.catalogAgentInspection', AspcCatalogAgentInspectionRequest>
  | JsonRpcRequest<'aspc.inspectAgentSelection', AspcInspectAgentSelectionRequest>
  | JsonRpcRequest<'aspc.compileHarnessInvocation', AspcCompileHarnessInvocationRequest>
  | JsonRpcRequest<'aspc.resolveRuntimeDeclaration', AspcResolveRuntimeDeclarationRequest>
  | JsonRpcRequest<'aspc.inspectRuntimePlacement', AspcInspectRuntimePlacementRequest>
  | JsonRpcRequest<'aspc.observeRuntimeCapability', AspcObserveRuntimeCapabilityRequest>
  | JsonRpcRequest<'aspc.observeContinuationArtifact', AspcObserveContinuationArtifactRequest>
  | JsonRpcRequest<'aspc.prepareProcessInvocation', AspcPrepareProcessInvocationRequest>
  | JsonRpcRequest<'aspc.compileAndStart', AspcCompileAndStartRequest>

export interface AspcHelloRequest {
  clientInfo: {
    name: string
    version?: string | undefined
  }
  protocolVersions: string[]
  capabilities?:
    | {
        compileRuntimePlan?: boolean | undefined
        catalogAgents?: boolean | undefined
        inspectAgent?: boolean | undefined
        catalogAgentInspection?: boolean | undefined
        inspectAgentSelection?: boolean | undefined
        compileHarnessInvocation?: boolean | undefined
        resolveRuntimeDeclaration?: boolean | undefined
        inspectRuntimePlacement?: boolean | undefined
        inspectRuntimePlacementPreparationCorrelation?: boolean | undefined
        observeRuntimeCapability?: boolean | undefined
        observeContinuationArtifact?: boolean | undefined
        compileAndStart?: boolean | undefined
        prepareProcessInvocation?: boolean | undefined
      }
    | undefined
}

export interface AspcHelloResponse {
  facadeInfo: {
    name: 'aspc-facade'
    version: string
  }
  protocolVersion: AspcProtocolVersion
  capabilities: {
    compileRuntimePlan: true
    catalogAgents: true
    inspectAgent: true
    catalogAgentInspection: true
    inspectAgentSelection: true
    compileHarnessInvocation: true
    resolveRuntimeDeclaration: true
    inspectRuntimePlacement: true
    /** T-08579: inspect accepts `preparationCorrelation`; parity consumers require it. */
    inspectRuntimePlacementPreparationCorrelation: true
    observeRuntimeCapability: true
    observeContinuationArtifact: true
    compileAndStart: boolean
    prepareProcessInvocation: true
    cohostedBroker: boolean
    transports: AspcTransportKind[]
  }
  brokerProtocol?: 'harness-broker/0.2' | 'harness-broker/0.3' | undefined
  /**
   * The immutable ASP release serving this connection (T-08539). Absent when
   * the compile plane is not running from a release (checkout/stdio facade).
   */
  release?: AspReleaseIdentity | undefined
}

export type AspcTransportKind = 'stdio-jsonrpc-ndjson' | 'unix-jsonrpc-ndjson'

export type AspcPrepareProcessInvocationRequest = {
  schemaVersion: 'aspc-prepare-process-invocation-request/v1'
  context: AspcRuntimeDeclarationContext
  preparationCorrelation: {
    hostSessionId?: string
    runId?: string
    generation?: number
    sessionRef?: { scopeRef: string; laneRef: string }
  }
  expected: { provider: 'anthropic' | 'openai'; frontend: string }
  launch: {
    interactionMode: 'interactive' | 'headless'
    ioMode: 'pty' | 'inherit' | 'pipes'
    model?: string | undefined
    modelReasoningEffort?: string | undefined
    continuation?: { provider: 'anthropic' | 'openai'; key?: string | undefined } | undefined
    prompt?: string | undefined
    omitPriming?: boolean | undefined
    attachments?: ProcessAttachmentRef[] | undefined
    yolo?: boolean | undefined
  }
  dispatchEnv?: Record<string, string>
  lockedEnv?: Record<string, string>
  artifactDir?: string
}

export type AspcPreparationFailure = {
  kind: 'incompatible' | 'unavailable' | 'invalid'
  code: string
  message: string
}
export type AspcPrepareProcessInvocationResponse =
  | (BuildProcessInvocationSpecResponse & {
      schemaVersion: typeof ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION
      ok: true
      declaration: {
        provider: 'anthropic' | 'openai'
        frontend: string
        agentSources: AspcResolvedCallerAgentSources
      }
      effectiveEnvironmentHash: string
      diagnostics: CompileDiagnostic[]
      release?: AspReleaseIdentity & { releaseRoot: string }
    })
  | {
      schemaVersion: typeof ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION
      ok: false
      failure: AspcPreparationFailure
    }
  | (Omit<AspcDeclarationResolutionFailure, 'schemaVersion'> & {
      schemaVersion: typeof ASPC_PREPARE_PROCESS_INVOCATION_RESPONSE_VERSION
    })

/**
 * Release binding for a compiled harness invocation (T-08539). Names the
 * release that prepared it and the worker executable inside that release, so a
 * host launches the worker without choosing a binary by driver name or through
 * PATH. The remaining worker flags are the existing broker CLI hosting
 * contract (`--socket`, `--event-ledger`, identity flags).
 */
export interface AspcExecutionRelease extends AspReleaseIdentity {
  /** Canonical absolute directory of the release. */
  releaseRoot: string
  worker: {
    /** The selected profile's broker protocol; the worker hello must negotiate it. */
    protocol: BrokerProtocolVersion
    /** Absolute selected release worker launcher inside `releaseRoot`. */
    executable: string
    /** Sorted manifest bindings assigned to this executable (positive hosting evidence). */
    hostedDrivers?: string[] | undefined
    argvPrefix: string[]
  }
}

export interface AspcCompileRuntimePlanRequest {
  compileRequest: RuntimeCompileRequest
  aspHome?: string | undefined
  /**
   * Optional, serializable compile context (T-04133). Pins clock/id-salt and
   * toolchain so a compile is reproducible under a release gate. Production
   * callers omit it.
   */
  compileContext?: CompileContext | undefined
}

export interface AspcCatalogAgentsRequest {
  evaluationContext: AgentInspectionEvaluationContext
}

export interface AspcInspectAgentRequest {
  request: AgentInspectionRequest
  evaluationContext: AgentInspectionEvaluationContext
}

export type AspcProfileSelector = {
  profileId?: string | undefined
  profileHash?: string | undefined
  brokerDriver?: string | undefined
}

export interface AspcCompileHarnessInvocationRequest extends AspcCompileRuntimePlanRequest {
  profileSelector?: AspcProfileSelector | undefined
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export type AspcCompileHarnessInvocationResponse =
  | {
      schemaVersion: typeof ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION
      ok: true
      compileResponse: Extract<RuntimeCompileResponse, { ok: true }>
      plan: CompiledRuntimePlan
      selectedProfile: BrokerExecutionProfile
      startRequest: BrokerExecutionProfile['harnessInvocation']['startRequest']
      dispatchRequest: InvocationDispatchRequest
      diagnostics: CompileDiagnostic[]
      /** Canonical hash of the preparation execution environment (T-08579). */
      effectiveEnvironmentHash?: string | undefined
      /** Present when the compile plane serves from an immutable release. */
      executionRelease?: AspcExecutionRelease | undefined
    }
  | {
      schemaVersion: typeof ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION
      ok: false
      compileResponse: RuntimeCompileResponse
      diagnostics: CompileDiagnostic[]
    }

export type AspcCompileAndStartRequest = AspcCompileHarnessInvocationRequest

export type AspcRuntimeDeclarationContext = {
  agentId: string
  agentRoot?: string | undefined
  project:
    | { mode: 'root'; projectRoot: string; projectId?: string | undefined }
    | { mode: 'infer-from-cwd' }
    | { mode: 'none' }
  cwd: string
  runMode: 'query' | 'heartbeat' | 'task' | 'maintenance'
  taskId?: string | undefined
  agentSources?: { aspHome?: string | undefined; agentsRoot?: string | undefined } | undefined
  provisionDirectives?: Record<string, string | number | boolean> | undefined
}

export type AspcResolveRuntimeDeclarationRequest = {
  schemaVersion: 'aspc-resolve-runtime-declaration-request/v1'
  context: AspcRuntimeDeclarationContext
}

export type AspcInspectRuntimePlacementRequest = {
  schemaVersion: 'aspc-inspect-runtime-placement-request/v1'
  context: AspcRuntimeDeclarationContext
  /**
   * The placement correlation the paired preparation compiled (T-08579). Send
   * only when hello advertises `inspectRuntimePlacementPreparationCorrelation`.
   */
  preparationCorrelation?: AspcPrepareProcessInvocationRequest['preparationCorrelation'] | undefined
  /** Accepted for parity with preparation; never a prompt input (T-08563 rev 5.2). */
  dispatchEnv?: Record<string, string> | undefined
}

export type AspcObserveRuntimeCapabilityRequest = {
  schemaVersion: 'aspc-observe-runtime-capability-request/v1'
  harness: string
  context: AspcRuntimeDeclarationContext
}

export type AspcHistoricalExecutionEvidence = {
  frozenStartRequest?:
    | {
        keyBinding: 'runtime-continuation'
        placement: RuntimePlacement
        startRequest: InvocationStartRequest
        brokerDriver?:
          | 'codex-app-server'
          | 'claude-code-tmux'
          | 'codex-cli-tmux'
          | 'pi-tui-tmux'
          | 'pi-sdk'
          | 'agent-harness'
          | 'agent-harness-tmux'
          | undefined
        compileId?: string | undefined
        planHash?: string | undefined
        selectedProfileHash?: string | undefined
        startRequestHash?: string | undefined
        executionRelease?: AspcExecutionRelease | undefined
      }
    | undefined
  recordedPlacement?:
    | {
        placement: RuntimePlacement
        bundle: RuntimePlacement['bundle']
        aspHome?: string | undefined
        compileId?: string | undefined
        planHash?: string | undefined
        selectedProfileHash?: string | undefined
      }
    | undefined
}

export type AspcObserveContinuationArtifactRequest = {
  schemaVersion: 'aspc-observe-continuation-artifact-request/v1'
  continuation: {
    provider: string
    key: string
    artifactFormat?: 'claude' | 'codex' | 'pi' | undefined
  }
  historicalExecution?: AspcHistoricalExecutionEvidence | undefined
}

export type AspcObservationFailure<Code extends string> = {
  kind: 'unavailable' | 'incompatible'
  code: Code
  message: string
  diagnostics?: Array<Record<string, unknown>> | undefined
}

export type AspcDeclarationDiagnostic = {
  severity: 'info' | 'warning' | 'error'
  code:
    | 'agent_profile_invalid'
    | 'project_targets_invalid'
    | 'selected_target_invalid'
    | 'priming_invalid'
    | 'source_read_failed'
    | 'unsupported_directive'
  message: string
  source: 'agent-profile' | 'project-targets' | 'selected-target' | 'priming' | 'directive'
  path?: string | undefined
}

export type AspcDeclarationSourceObservation =
  | { state: 'absent'; code: 'not_declared' }
  | { state: 'valid'; code: 'parsed'; contentHash: string }
  | { state: 'invalid'; diagnostics: AspcDeclarationDiagnostic[] }

export type AspcAgentProfileSourceObservation =
  | { state: 'absent'; code: 'not_declared' }
  | {
      state: 'valid'
      code: 'parsed'
      contentHash: string
      declaredHarness?: string | undefined
      declaredProvider?: 'anthropic' | 'openai' | undefined
    }
  | { state: 'invalid'; diagnostics: AspcDeclarationDiagnostic[] }

export type AspcResolvedCallerAgentSources = {
  aspHome?: string | undefined
  agentsRoot?: string | undefined
  provenance:
    | 'caller-agent-root'
    | 'caller'
    | 'caller-asp-home-config'
    | 'project-marker'
    | 'daemon-default'
}

export type AspcRuntimeDeclarationSources = {
  agentProfile: AspcAgentProfileSourceObservation
  projectTargets: AspcDeclarationSourceObservation
  selectedTarget: AspcDeclarationSourceObservation
  priming: AspcDeclarationSourceObservation
}

export type AspcProvisioningObservation = {
  scalars: Record<string, string | number | boolean>
  declaredHarness?: string | undefined
  effectiveHarness: string
  frontend: string
  provider: 'anthropic' | 'openai'
  transport: 'cli' | 'sdk'
  family: string
  runtime: string
}

export type AspcResolvedRuntimePlacement = RuntimePlacement & {
  agentRoot: string
  projectRoot?: string | undefined
  cwd: string
  runMode: AspcRuntimeDeclarationContext['runMode']
  bundle: NonNullable<RuntimePlacement['bundle']>
}

type AspcDeclarationResolutionFailure = {
  schemaVersion: typeof ASPC_RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION
  ok: false
  agentSources: AspcResolvedCallerAgentSources
  markerProjectId?: string | undefined
  searchedAgentRoots: string[]
  source: AspcRuntimeDeclarationSources
  resolution: {
    state: 'absent' | 'invalid'
    code:
      | 'agent_not_found'
      | 'agent_profile_invalid'
      | 'project_targets_invalid'
      | 'selected_target_invalid'
      | 'priming_invalid'
    message: string
    diagnostics: AspcDeclarationDiagnostic[]
  }
}

export type AspcResolveRuntimeDeclarationResponse =
  | {
      schemaVersion: typeof ASPC_RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION
      ok: true
      evaluatedAt: string
      contextHash: string
      agentSources: AspcResolvedCallerAgentSources
      markerProjectId?: string | undefined
      searchedAgentRoots: string[]
      source: AspcRuntimeDeclarationSources
      identity: { role?: string | undefined; operator: boolean }
      policy: {
        claimsTask: boolean
        provisioningNode?: string | undefined
        placement: { pins: Record<string, string>; homes: Record<string, string> }
      }
      baselineProvisioning: AspcProvisioningObservation
      provisioning: AspcProvisioningObservation
      priming?: { content: string; source: string } | undefined
      placement: AspcResolvedRuntimePlacement
      bundle: { ref: AspcResolvedRuntimePlacement['bundle']; identity: string }
      diagnostics: AspcDeclarationDiagnostic[]
    }
  | AspcDeclarationResolutionFailure
  | {
      schemaVersion: typeof ASPC_RESOLVE_RUNTIME_DECLARATION_RESPONSE_VERSION
      ok: false
      failure: AspcObservationFailure<
        | 'configured_source_unavailable'
        | 'source_read_unavailable'
        | 'configured_context_mismatch'
        | 'unsupported_schema'
        | 'unsupported_harness'
        | 'unsupported_directive'
      >
    }

export type AspcRuntimePromptObservation =
  | {
      state: 'present'
      value: {
        systemPrompt: string
        systemPromptMode: 'append' | 'replace'
        reminderContent?: string | undefined
        primingPrompt?: string | undefined
        promptSectionSizes: Array<{ name: string; chars: number }>
        reminderSectionSizes: Array<{ name: string; chars: number }>
        promptTotalChars: number
        reminderTotalChars: number
        totalContextChars: number
        maxChars?: number | undefined
        nearMaxChars: boolean
      }
    }
  | { state: 'absent'; code: 'prompt_not_declared' }
  | {
      state: 'invalid'
      code: 'prompt_resolution_failed'
      message: string
      diagnostics: Array<Record<string, unknown>>
    }

export type AspcInspectRuntimePlacementResponse =
  | {
      schemaVersion: typeof ASPC_INSPECT_RUNTIME_PLACEMENT_RESPONSE_VERSION
      ok: true
      declaration: Extract<AspcResolveRuntimeDeclarationResponse, { ok: true }>
      inspection: AgentInspectionResult
      prompt: AspcRuntimePromptObservation
      effectiveEnvironmentHash: string
    }
  | {
      schemaVersion: typeof ASPC_INSPECT_RUNTIME_PLACEMENT_RESPONSE_VERSION
      ok: false
      declaration: Extract<AspcResolveRuntimeDeclarationResponse, { ok: false }>
    }

export type AspcCapabilityFactResponse = {
  schemaVersion: typeof ASPC_OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION
  ok: true
  harness: { requested: string; frontend?: string | undefined; provider?: 'anthropic' | 'openai' }
  registration:
    | { state: 'present'; code: 'registered' }
    | { state: 'absent'; code: 'not_registered' }
  nativeRuntime:
    | { state: 'present'; code: 'native_available' }
    | { state: 'absent'; code: 'native_unavailable' }
    | { state: 'unknown'; code: 'detection_failed' }
  credentials:
    | { state: 'present'; code: 'credentials_present' | 'credentials_not_required' }
    | { state: 'absent'; code: 'credentials_missing' }
    | { state: 'unknown'; code: 'credential_source_unreadable' }
  preparation:
    | { state: 'present'; code: 'preparation_ready' }
    | {
        state: 'absent'
        code: 'not_registered' | 'native_unavailable' | 'credentials_missing' | 'driver_unhosted'
      }
    | { state: 'unknown'; code: 'preparation_unknown' }
  diagnostics: Array<{
    code:
      | 'probe_timeout'
      | 'probe_output_limit'
      | 'probe_exit_nonzero'
      | 'probe_failed'
      | 'version_below_minimum'
    probe: 'version' | 'help' | 'app-server-help'
    message: string
    candidate?: string | undefined
  }>
}

export type AspcObserveRuntimeCapabilityResponse =
  | AspcCapabilityFactResponse
  | {
      schemaVersion: typeof ASPC_OBSERVE_RUNTIME_CAPABILITY_RESPONSE_VERSION
      ok: false
      failure: AspcObservationFailure<
        | 'configured_context_mismatch'
        | 'unsupported_schema'
        | 'unsupported_harness'
        | 'observation_failed'
      >
    }

export type AspcArtifactObservation =
  | { state: 'present'; code: 'artifact_present' }
  | { state: 'missing'; code: 'artifact_missing' }
  | {
      state: 'unknown'
      code:
        | 'context_unavailable'
        | 'home_not_historical'
        | 'home_unreadable'
        | 'artifact_format_ambiguous'
        | 'key_not_absolute'
        | 'provider_not_observable'
    }

export type AspcObserveContinuationArtifactResponse =
  | {
      schemaVersion: typeof ASPC_OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION
      ok: true
      requested: AspcObserveContinuationArtifactRequest['continuation']
      executionProvider?: 'anthropic' | 'openai' | undefined
      artifactFormat: 'claude' | 'codex' | 'pi' | 'unknown'
      artifact: AspcArtifactObservation
      basis: 'frozen-home' | 'recorded-placement-rule' | 'absolute-key' | 'none'
      diagnostics: Array<{ code: 'historical_evidence_disagrees'; message: string }>
    }
  | {
      schemaVersion: typeof ASPC_OBSERVE_CONTINUATION_ARTIFACT_RESPONSE_VERSION
      ok: false
      failure: AspcObservationFailure<
        'unsupported_schema' | 'unsupported_provider' | 'evidence_invalid' | 'observation_failed'
      >
    }

export type AspcCompileAndStartResponse =
  | {
      schemaVersion: typeof ASPC_COMPILE_AND_START_RESPONSE_VERSION
      ok: true
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: true }>
      startResponse: InvocationStartResponse
    }
  | {
      schemaVersion: typeof ASPC_COMPILE_AND_START_RESPONSE_VERSION
      ok: false
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: false }>
      diagnostics: CompileDiagnostic[]
    }
