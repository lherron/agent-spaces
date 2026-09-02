/**
 * Placement-based public API types and helpers.
 *
 * These types supersede the SpaceSpec-based request shapes.
 * See AGENT_SPACES_PLAN.md "Target public API" section.
 */

import type {
  AgentLocalComponents,
  ComposedTargetBundle,
  HarnessFrontend as ConfigHarnessFrontend,
  HarnessAdapter,
  HarnessId,
  HarnessProvider,
  HarnessRunOptions,
  ResolvedPlacementContext,
  ResolvedRuntimeBundle,
  RuntimePlacement,
} from 'spaces-config'
import type { AttachmentRef } from 'spaces-runtime'
import type { PlacementRuntimePlan } from 'spaces-runtime-contracts'
import { buildAgentSessionEnv } from './agent-session-env.js'
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
  /** Execution-plane behavior supplied by an apps/harness composition root. */
  runtime?: AgentSpacesRuntimeDependencies | undefined
}

export type CompilerPlacementRuntimePlan = PlacementRuntimePlan<
  ConfigHarnessFrontend,
  HarnessId,
  HarnessProvider,
  Partial<HarnessRunOptions>
>

export interface AgentSpacesRuntimeDependencies {
  getHarnessAdapter(harnessId: HarnessId): HarnessAdapter
  detectAgentLocalComponents(agentRoot: string): Promise<AgentLocalComponents | undefined>
  planPlacementRuntime(options: {
    placement: RuntimePlacement
    placementContext: ResolvedPlacementContext
    frontend: ConfigHarnessFrontend
    aspHome: string
    model?: string | undefined
    prompt?: string | undefined
    promptOverrideMode?: 'nullish' | 'truthy' | 'exact' | undefined
    yolo?: boolean | undefined
    interactive?: boolean | undefined
    continuationKey?: string | boolean | undefined
  }): Promise<CompilerPlacementRuntimePlan>
  prepareCodexRuntimeHome(
    bundle: ComposedTargetBundle,
    runOptions: HarnessRunOptions
  ): Promise<string>
  prepareAgentToolRuntime(
    context: {
      agentRoot: string
      projectRoot?: string | undefined
      projectId?: string | undefined
      components?: AgentLocalComponents | undefined
    },
    baseEnv?: Record<string, string>
  ): Promise<{
    env: Record<string, string>
    pathPrepend: string[]
    warnings: string[]
  }>
}

export function requireAgentSpacesRuntime(
  runtime: AgentSpacesRuntimeDependencies | undefined
): AgentSpacesRuntimeDependencies {
  if (runtime === undefined) {
    throw new Error(
      'Agent Spaces execution dependencies were not provided; bind them at the apps/harness composition root.'
    )
  }
  return runtime
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
 * Build runtime-only agent session environment variables from a RuntimePlacement.
 * These values are per-launch dispatch metadata and must stay out of lockedEnv.
 */
export function buildCorrelationEnvVars(placement: RuntimePlacement): Record<string, string> {
  return buildAgentSessionEnv(placement)
}
