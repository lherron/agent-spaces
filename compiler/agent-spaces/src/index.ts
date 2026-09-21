export type {
  AgentEvent,
  AgentSpacesClient,
  AgentSpacesError,
  BaseEvent,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationKey,
  HarnessContinuationRef,
  HarnessFrontend,
  HostCorrelation,
  InteractionMode,
  InterruptInFlightTurnRequest,
  InvocationSpecBuilder,
  IoMode,
  ProcessInvocationSpec,
  ProviderDomain,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  ResolveRequest,
  ResolveResponse,
  RunResult,
  RuntimeCompiler,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
  SessionCallbacks,
  SessionState,
  SpaceResolver,
  SpaceSpec,
  TurnExecutor,
} from './types.js'

export type {
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

export type {
  AgentSpacesClientOptions,
  PlacementBuildInvocationRequest,
  PlacementBuildInvocationResponse,
  PlacementRunTurnRequest,
  PlacementRunTurnResponse,
} from './placement-api.js'

export { buildCorrelationEnvVars } from './placement-api.js'

export {
  ARRIS_FRONTEND,
  ARRIS_PARTICIPANT_ADAPTER_ID,
  ARRIS_PROCESS_COMMAND,
  ARRIS_PRODUCT_ID,
  ARRIS_RESIDENT_DRIVER_KIND,
  arrisProductConfig,
  createArrisParticipantAdapter,
  createResidentParticipantAdapter,
  type ArrisParticipantAdapterOptions,
  type ArrisParticipantContinuityEvidence,
  type ArrisParticipantEvidence,
  type ArrisParticipantPreparation,
  type ResidentParticipantAdapterOptions,
  type ResidentProductConfig,
  type ValidatedResidentProduct,
} from './arris-participant-adapter.js'

export { createAgentSpacesClient } from './client.js'

export {
  HARNESS_CATALOG,
  HARNESS_IDS,
  assertCatalogBuilderCoherence,
  BUILDER_REGISTRY_IDS,
  catalogCapabilities,
  catalogHarnessIds,
  catalogRecipes,
  resolveHarnessExecution,
} from './harness-selection/index.js'
export type {
  BuilderId,
  CompileRefusal,
  ExecutionRecipe,
  HarnessDefinition,
  HarnessResolution,
  ProvisioningLayer,
  ProvisioningLayers,
  ResolveHarnessExecutionInput,
  ResolvedHarnessExecution,
} from './harness-selection/index.js'

export { admitDesktopRegistration, resolveDesktopIdentity } from './desktop-native-identity.js'
export {
  CODEX_DESKTOP_PARTICIPANT_ADAPTER_ID,
  CODEX_DESKTOP_PARTICIPANT_CLASS,
  createCodexDesktopParticipantAdapter,
  type CodexDesktopParticipantContinuityEvidence,
  type CodexDesktopParticipantEvidence,
  type CodexDesktopParticipantPreparation,
} from './codex-desktop-participant-adapter.js'
export type {
  CodexDesktopObserverIdentity,
  CodexDesktopObserverProfileFailure,
  CodexDesktopObserverProfileRequest,
} from './desktop-observer-preparation.js'

export {
  checkContinuationArtifact,
  observeContinuationArtifact,
  type CheckContinuationArtifactOptions,
  type ContinuationArtifactRef,
  type ContinuationArtifactResult,
} from './continuation-probe.js'

export {
  resolveRuntimeDeclaration,
  type RuntimeDeclarationOptions,
} from './runtime-declaration.js'

export { observeRuntimeCapability } from './runtime-capability.js'

export {
  catalogAgentsForContext,
  catalogAgentSources,
  inspectAgentForContext,
  inspectRuntimePlacement,
  type AgentCatalogDiagnostic,
  type AgentCatalogResult,
  type AgentCatalogRow,
  type AgentInspectionOperationOutcome,
  type InspectAgentForContextOptions,
  type InspectRuntimePlacementOptions,
} from './agent-inspection.js'
