import type { AgentLocalComponents, AgentProfileBrain, AgentRuntimeProfile } from 'spaces-config'

export interface AgentBrainRuntimeContext {
  agentRoot: string
  agentName?: string | undefined
  components?: AgentLocalComponents | undefined
  profile?: AgentRuntimeProfile | undefined
  brain?: AgentProfileBrain | undefined
}

export type AgentBrainEnvResult = Record<string, never>

export async function prepareAgentBrainRuntime(
  _context: AgentBrainRuntimeContext,
  _baseEnv: Record<string, string> = {}
): Promise<AgentBrainEnvResult> {
  return {}
}
