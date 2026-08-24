import type { AgentLocalComponents } from '../core/types/agent-local.js'
import type { RuntimePlacement } from '../core/types/placement.js'
import { RESERVED_AGENT_SESSION_ENV_KEYS, buildAgentSessionEnv } from './agent-session-env.js'

export interface AgentToolRuntimePreparer {
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

export interface ComposeAgentRuntimeEnvRequest {
  placement: RuntimePlacement
  agentLocalComponents: AgentLocalComponents | undefined
  aspHome: string
  reqLockedEnv?: Record<string, string> | undefined
  reqDispatchEnv?: Record<string, string> | undefined
  adapterEnv?: Record<string, string> | undefined
  agentchatEnv?: Record<string, string> | undefined
}

export interface ComposedAgentRuntimeEnv {
  lockedEnv: Record<string, string>
  dispatchEnv: Record<string, string>
  env: Record<string, string>
  pathPrepend: string[]
  warnings: string[]
}

export async function composeAgentRuntimeEnv(
  req: ComposeAgentRuntimeEnvRequest,
  runtime: AgentToolRuntimePreparer
): Promise<ComposedAgentRuntimeEnv> {
  const correlationEnv = buildAgentSessionEnv(req.placement)
  let lockedEnv: Record<string, string> = {
    ...(req.adapterEnv ?? {}),
    ...(req.agentchatEnv ?? {}),
    ...(req.reqLockedEnv ?? {}),
    ASP_HOME: req.aspHome,
  }
  const callerDispatchEnv = { ...(req.reqDispatchEnv ?? {}) }
  for (const key of RESERVED_AGENT_SESSION_ENV_KEYS) {
    delete callerDispatchEnv[key]
  }
  const dispatchEnv: Record<string, string> = {
    ...callerDispatchEnv,
    ...correlationEnv,
  }
  let env: Record<string, string> = { ...lockedEnv, ...dispatchEnv }

  let pathPrepend: string[] = []
  const warnings: string[] = []
  const projectId = correlationEnv['AGENT_PROJECT']
  const toolRuntime = await runtime.prepareAgentToolRuntime(
    {
      agentRoot: req.placement.agentRoot,
      projectRoot: req.placement.projectRoot,
      ...(projectId !== undefined ? { projectId } : {}),
      ...(req.agentLocalComponents ? { components: req.agentLocalComponents } : {}),
    },
    env
  )
  const { PATH: toolPath, ...toolLockedEnv } = toolRuntime.env
  void toolPath
  pathPrepend = toolRuntime.pathPrepend
  lockedEnv = { ...lockedEnv, ...toolLockedEnv }
  env = { ...env, ...toolRuntime.env }
  warnings.push(...toolRuntime.warnings)

  return { lockedEnv, dispatchEnv, env, pathPrepend, warnings }
}
