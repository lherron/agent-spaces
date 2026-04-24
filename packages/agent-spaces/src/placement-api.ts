/**
 * Placement-based public API types and helpers.
 *
 * These types supersede the SpaceSpec-based request shapes.
 * See AGENT_SPACES_PLAN.md "Target public API" section.
 */

import type { ResolvedRuntimeBundle, RuntimePlacement } from 'spaces-config'
import type {
  AgentSpacesError,
  HarnessContinuationRef,
  ProcessInvocationSpec,
  ProviderDomain,
  RunResult,
  SessionCallbacks,
} from './types.js'

// ============================================================================
// Client construction
// ============================================================================

/** Options for creating an AgentSpacesClient */
export interface AgentSpacesClientOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
}

// ============================================================================
// Request/Response: NonInteractive turn execution (placement-based)
// ============================================================================

export interface PlacementRunTurnRequest {
  placement: RuntimePlacement
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  continuation?: HarnessContinuationRef | undefined
  env?: Record<string, string> | undefined
  prompt: string
  attachments?: string[] | undefined
  callbacks: SessionCallbacks
}

export interface PlacementRunTurnResponse {
  continuation?: HarnessContinuationRef | undefined
  provider: ProviderDomain
  frontend: 'agent-sdk' | 'pi-sdk'
  model?: string | undefined
  result: RunResult
  resolvedBundle?: ResolvedRuntimeBundle | undefined
}

// ============================================================================
// Request/Response: CLI invocation preparation (placement-based)
// ============================================================================

export interface PlacementBuildInvocationRequest {
  placement: RuntimePlacement
  provider: ProviderDomain
  frontend: 'claude-code' | 'codex-cli'
  model?: string | undefined
  interactionMode: 'interactive' | 'headless'
  ioMode: 'pty' | 'inherit' | 'pipes'
  continuation?: HarnessContinuationRef | undefined
  env?: Record<string, string> | undefined
  artifactDir?: string | undefined
}

export interface PlacementBuildInvocationResponse {
  spec: ProcessInvocationSpec
  resolvedBundle?: ResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}

// ============================================================================
// Correlation env vars (section 12)
// ============================================================================

/**
 * Build correlation environment variables from a RuntimePlacement.
 *
 * When correlation.sessionRef is present:
 * - AGENT_SCOPE_REF = sessionRef.scopeRef
 * - AGENT_LANE_REF = sessionRef.laneRef
 * - HRC_SESSION_REF = scopeRef/laneRef  (consumed by hrcchat to identify the caller)
 *
 * When correlation.hostSessionId is present:
 * - AGENT_HOST_SESSION_ID = hostSessionId
 *
 * These vars are advisory only.
 */
export function buildCorrelationEnvVars(placement: RuntimePlacement): Record<string, string> {
  const env: Record<string, string> = {}

  if (placement.correlation?.sessionRef) {
    env['AGENT_SCOPE_REF'] = placement.correlation.sessionRef.scopeRef
    env['AGENT_LANE_REF'] = placement.correlation.sessionRef.laneRef
    env['HRC_SESSION_REF'] =
      `${placement.correlation.sessionRef.scopeRef}/${placement.correlation.sessionRef.laneRef}`
  }

  if (placement.correlation?.hostSessionId) {
    env['AGENT_HOST_SESSION_ID'] = placement.correlation.hostSessionId
  }

  return env
}

// ============================================================================
// Provider validation helpers
// ============================================================================

const FRONTEND_PROVIDER_MAP: Record<string, ProviderDomain> = {
  'agent-sdk': 'anthropic',
  'claude-code': 'anthropic',
  'pi-sdk': 'openai',
  'codex-cli': 'openai',
}

/**
 * Get the expected provider for a frontend.
 */
export function getProviderForFrontend(frontend: string): ProviderDomain {
  const provider = FRONTEND_PROVIDER_MAP[frontend]
  if (!provider) {
    throw new Error(`Unknown frontend: "${frontend}"`)
  }
  return provider
}

/**
 * Validate that a continuation's provider matches the expected provider for a frontend.
 */
export function validateProviderMatch(
  frontend: string,
  continuation?: HarnessContinuationRef
): AgentSpacesError | undefined {
  if (!continuation) return undefined

  const expected = getProviderForFrontend(frontend)
  if (continuation.provider !== expected) {
    return {
      message: `Provider mismatch: frontend "${frontend}" requires provider "${expected}" but continuation has provider "${continuation.provider}"`,
      code: 'provider_mismatch',
    }
  }

  return undefined
}

// ============================================================================
// Placement-aware client interface
// ============================================================================

export interface PlacementAgentSpacesClient {
  runTurnNonInteractive(req: PlacementRunTurnRequest): Promise<PlacementRunTurnResponse>
  buildProcessInvocationSpec(
    req: PlacementBuildInvocationRequest
  ): Promise<PlacementBuildInvocationResponse>
}
