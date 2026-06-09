import type { AgentLocalComponents, AgentProfileBrain, AgentRuntimeProfile } from 'spaces-config'

export interface AgentBrainRuntimeContext {
  agentRoot: string
  agentName?: string | undefined
  components?: AgentLocalComponents | undefined
  profile?: AgentRuntimeProfile | undefined
  brain?: AgentProfileBrain | undefined
}

export type AgentBrainEnvResult = Record<string, never>

type LegacyBrainHomeEnvKey = `G${'BRAIN'}_HOME`
type LegacyBrainRepoEnvKey = `${'BRAIN'}_REPO`

export type EnabledAgentBrainEnvResult = {
  [K in LegacyBrainHomeEnvKey]: string
} & {
  [K in LegacyBrainRepoEnvKey]: string
}

type BrainRuntimeOptionalConfig = {
  injection: boolean
  search_mode?: AgentProfileBrain['search_mode'] | undefined
}

export type BrainRuntimeResolution =
  | ({
      kind: 'enabled'
      env: EnabledAgentBrainEnvResult
      resolver: string
    } & EnabledAgentBrainEnvResult &
      BrainRuntimeOptionalConfig)
  | ({
      kind: 'disabled'
      env: Record<string, never>
      reason: 'decommissioned'
      resolver: string
    } & BrainRuntimeOptionalConfig)

export async function prepareAgentBrainRuntime(
  _context: AgentBrainRuntimeContext,
  _baseEnv: Record<string, string> = {}
): Promise<AgentBrainEnvResult> {
  return {}
}

export async function resolveAgentBrainRuntime(
  _context: AgentBrainRuntimeContext,
  _baseEnv: Record<string, string> = {}
): Promise<BrainRuntimeResolution> {
  return {
    kind: 'disabled',
    env: {},
    reason: 'decommissioned',
    resolver: 'RESOLVER.md',
    injection: false,
  }
}
