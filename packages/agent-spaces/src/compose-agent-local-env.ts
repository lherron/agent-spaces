import type { AgentLocalComponents, RuntimePlacement } from 'spaces-config'
import { prepareAgentToolRuntime } from 'spaces-execution'

import { RESERVED_AGENT_SESSION_ENV_KEYS } from './agent-session-env.js'
import { buildCorrelationEnvVars } from './placement-api.js'

/**
 * Inputs to {@link composeAgentLocalEnv}. The optional/flag fields encode the
 * deliberate divergence between the two call sites — see the field docs.
 */
export interface ComposeAgentLocalEnvRequest {
  placement: RuntimePlacement
  /** Pre-detected agent-local components (skills/commands/tools) for this placement. */
  agentLocalComponents: AgentLocalComponents | undefined
  aspHome: string
  reqLockedEnv?: Record<string, string> | undefined
  reqDispatchEnv?: Record<string, string> | undefined
  /**
   * Adapter run env folded into lockedEnv. The CLI path supplies it (codex
   * CODEX_HOME etc.); the placement turn path omits it.
   */
  adapterEnv?: Record<string, string> | undefined
  /**
   * Agentchat discovery env (AGENTCHAT_ID/ASP_PROJECT) folded into lockedEnv.
   * The CLI path supplies it; the placement turn path omits it.
   */
  agentchatEnv?: Record<string, string> | undefined
}

export interface ComposedAgentLocalEnv {
  lockedEnv: Record<string, string>
  dispatchEnv: Record<string, string>
  /** Effective merged env: lockedEnv ⊕ dispatchEnv ⊕ tool env. */
  env: Record<string, string>
  /**
   * Ordered tool-bin dirs to prepend to PATH (typed PATH mutation, NOT lockedEnv).
   * Always computed; the placement turn caller deliberately ignores it.
   */
  pathPrepend: string[]
  /** Tool-runtime warnings. Always collected; the placement turn caller ignores them. */
  warnings: string[]
}

/**
 * Compose the agent-local env channels (locked/dispatch/effective) plus the
 * typed pathPrepend and tool warnings shared by the CLI runtime preparation and
 * the placement turn driver.
 *
 * The two call sites are NOT byte-equivalent and the divergence is preserved
 * exactly via the request flags:
 *  - CLI folds adapterEnv + agentchatEnv into lockedEnv and consumes
 *    pathPrepend + warnings.
 *  - Placement omits adapterEnv/agentchatEnv and ignores pathPrepend + warnings.
 *
 * PATH is never routed through lockedEnv; tool-bin dirs are surfaced via the
 * typed `pathPrepend` field (consumed by the broker env compose) instead.
 */
export async function composeAgentLocalEnv(
  req: ComposeAgentLocalEnvRequest
): Promise<ComposedAgentLocalEnv> {
  const { placement, agentLocalComponents, aspHome } = req

  // Build correlation env vars
  const correlationEnv = buildCorrelationEnvVars(placement)

  let lockedEnv: Record<string, string> = {
    ...(req.adapterEnv ?? {}),
    ...(req.agentchatEnv ?? {}),
    ...(req.reqLockedEnv ?? {}),
    ASP_HOME: aspHome,
  }
  const callerDispatchEnv = { ...(req.reqDispatchEnv ?? {}) }
  for (const key of RESERVED_AGENT_SESSION_ENV_KEYS) {
    delete callerDispatchEnv[key]
  }
  const dispatchEnv: Record<string, string> = {
    ...callerDispatchEnv,
    ...correlationEnv,
  }
  let env: Record<string, string> = {
    ...lockedEnv,
    ...dispatchEnv,
  }

  let pathPrepend: string[] = []
  const warnings: string[] = []
  if (agentLocalComponents?.hasTools) {
    const toolRuntime = await prepareAgentToolRuntime(
      {
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        components: agentLocalComponents,
      },
      env
    )
    const { PATH: toolPath, ...toolLockedEnv } = toolRuntime.env
    void toolPath
    // PATH is never routed through lockedEnv. The tool-bin dirs are emitted as
    // the typed HarnessProcessSpec.pathPrepend field (consumed by the broker
    // env compose) so the controlled PATH mutation is part of the launch shape.
    pathPrepend = toolRuntime.pathPrepend
    lockedEnv = { ...lockedEnv, ...toolLockedEnv }
    env = { ...env, ...toolRuntime.env }
    warnings.push(...toolRuntime.warnings)
  }

  return { lockedEnv, dispatchEnv, env, pathPrepend, warnings }
}
