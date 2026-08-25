import { loadAgent } from './agent-definition.js'
import type { ResolvedAgent } from './types.js'

/** Re-resolve direct ASP sources for Pi's effective cwd during session replacement. */
export async function reloadAgentForCwd(agent: ResolvedAgent, cwd: string): Promise<ResolvedAgent> {
  return loadAgent({
    ...agent.input,
    cwd,
    agentRoot: agent.placement.agentRoot,
    ...(agent.placement.projectRoot !== undefined
      ? { projectRoot: agent.placement.projectRoot }
      : {}),
    aspHome: agent.aspHome,
  })
}
