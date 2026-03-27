import type { SpaceRefString } from './refs.js'

export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export interface HarnessSettings {
  model?: string | undefined
  sandboxMode?: string | undefined
  approvalPolicy?: string | undefined
  profile?: string | undefined
}

export interface AgentProfileInstructions {
  additionalBase?: string[] | undefined
  byMode?: Partial<Record<RunMode, string[]>> | undefined
}

export interface AgentProfileSpaces {
  base?: SpaceRefString[] | undefined
  byMode?: Partial<Record<RunMode, SpaceRefString[]>> | undefined
}

export interface AgentProfileTarget {
  compose: SpaceRefString[]
}

export interface AgentRuntimeProfile {
  schemaVersion: 1
  instructions?: AgentProfileInstructions | undefined
  spaces?: AgentProfileSpaces | undefined
  targets?: Record<string, AgentProfileTarget> | undefined
  harnessDefaults?: HarnessSettings | undefined
  harnessByMode?: Partial<Record<RunMode, HarnessSettings>> | undefined
}
