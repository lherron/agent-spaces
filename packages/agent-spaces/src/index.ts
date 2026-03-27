export type {
  AgentEvent,
  AgentSpacesClient,
  AgentSpacesError,
  BaseEvent,
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
  IoMode,
  ProcessInvocationSpec,
  ProviderDomain,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  ResolveRequest,
  ResolveResponse,
  RunResult,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
  SessionCallbacks,
  SessionState,
  SpaceSpec,
} from './types.js'

export type {
  AgentSpacesClientOptions,
  PlacementBuildInvocationRequest,
  PlacementBuildInvocationResponse,
  PlacementRunTurnRequest,
  PlacementRunTurnResponse,
} from './placement-api.js'

export {
  buildCorrelationEnvVars,
  getProviderForFrontend,
  validateProviderMatch,
} from './placement-api.js'

export { createAgentSpacesClient } from './client.js'
