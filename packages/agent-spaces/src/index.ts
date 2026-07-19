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

export type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

export type {
  AgentSpacesClientOptions,
  PlacementBuildInvocationRequest,
  PlacementBuildInvocationResponse,
  PlacementRunTurnRequest,
  PlacementRunTurnResponse,
} from './placement-api.js'

export { buildCorrelationEnvVars } from './placement-api.js'

export { createAgentSpacesClient } from './client.js'

export {
  checkContinuationArtifact,
  type CheckContinuationArtifactOptions,
  type ContinuationArtifactRef,
  type ContinuationArtifactResult,
} from './continuation-probe.js'

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
  inspectAgentForContext,
  type AgentCatalogDiagnostic,
  type AgentCatalogResult,
  type AgentCatalogRow,
  type AgentInspectionOperationOutcome,
  type InspectAgentForContextOptions,
} from './agent-inspection.js'
