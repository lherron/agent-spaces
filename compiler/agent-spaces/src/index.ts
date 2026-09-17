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
  ARRIS_PARTICIPANT_ADAPTER_ID,
  ARRIS_RESIDENT_DRIVER_KIND,
  createArrisParticipantAdapter,
  type ArrisParticipantAdapterOptions,
  type ArrisParticipantContinuityEvidence,
  type ArrisParticipantEvidence,
  type ArrisParticipantPreparation,
} from './arris-participant-adapter.js'

export { createAgentSpacesClient } from './client.js'

export { admitDesktopRegistration, resolveDesktopIdentity } from './desktop-native-identity.js'
export { prepareDesktopObserver } from './desktop-observer-preparation.js'

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
  composeForegroundEnv,
  foregroundLaunchFromResponse,
  type ForegroundLaunch,
} from './foreground-launch.js'

export { createCompileRuntimeFn } from './run-compile.js'

export {
  type AgentCompileDryRunProjection,
  projectAgentCompileForDryRun,
  type RuntimeCompileDryRunProjection,
  type StableAgentCompileIdentity,
} from './dry-run-projection.js'

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
