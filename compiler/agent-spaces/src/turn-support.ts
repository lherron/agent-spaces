export { deriveHandleParts } from './broker-invocation.js'
export { materializeSpec, validateSpec, type ValidatedSpec } from './client-materialization.js'
export {
  AGENT_SDK_FRONTEND,
  PI_SDK_FRONTEND,
  assertSessionContinuationProvider,
  type SessionRuntimeFacts,
  resolveSessionRuntimeModel,
  sessionRuntimeFacts,
} from './session-runtime-facts.js'
export { CodedError } from './client-support.js'
export { composeAgentLocalEnv } from './compose-agent-local-env.js'
export type { AgentSpacesClientOptions, PlacementRunTurnRequest } from './placement-api.js'
export type {
  AgentEvent,
  AgentSpacesClient,
  AgentSpacesError,
  HarnessContinuationRef,
  ProviderDomain,
  RunResult,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
} from './types.js'
