/**
 * Placement-based public API types and helpers.
 *
 * These types supersede the SpaceSpec-based request shapes.
 * See AGENT_SPACES_PLAN.md "Target public API" section.
 */

import type { ResolvedRuntimeBundle, RuntimePlacement } from 'spaces-config'
import type { AttachmentRef } from 'spaces-runtime'
import type {
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
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  prompt: string
  attachments?: Array<string | AttachmentRef> | undefined
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
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
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
  }

  if (placement.correlation?.hostSessionId) {
    env['AGENT_HOST_SESSION_ID'] = placement.correlation.hostSessionId
  }

  return env
}
