import type { SpaceRefString } from './refs.js'
import type { ProvisioningSettings } from './targets.js'

export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

/** Closed suffix namespace reserved by every declared placement home base. */
export const ROSTER_SLOT_TOKENS = [
  'nova',
  'comet',
  'pulsar',
  'quasar',
  'meteor',
  'aurora',
  'zenith',
  'eclipse',
  'orbit',
  'cosmos',
] as const

export interface AgentIdentity {
  display?: string | undefined
  /** Default role used by scope resolution for task-bearing handles that omit a role. */
  role?: string | undefined
}

export interface AgentProfileInstructions {
  base?: string[] | undefined
  modes?: Partial<Record<RunMode, string[]>> | undefined
}

export interface AgentProfileSpaces {
  base?: SpaceRefString[] | undefined
  modes?: Partial<Record<RunMode, SpaceRefString[]>> | undefined
}

export interface AgentProfileTarget {
  compose: SpaceRefString[]
}

export interface AgentProfileSession {
  additionalContext?: string[] | undefined
  additionalExec?: string[] | undefined
}

/** Source policy for managed scheduled-job execution ownership. */
export interface AgentProfileJobs {
  default_node?: string[] | undefined
}

/** Source-shaped federation placement declaration from agent-profile.toml. */
export interface AgentProfilePlacement {
  pins: Record<string, string>
  homes: Record<string, string>
}

export interface AgentRuntimeProfile {
  version: 3
  claims_task?: boolean | undefined
  placement?: AgentProfilePlacement | undefined
  provisioning?: ProvisioningSettings | undefined
  jobs?: AgentProfileJobs | undefined
  identity?: AgentIdentity | undefined
  priming?: string | undefined
  priming_file?: string | undefined
  instructions?: AgentProfileInstructions | undefined
  session?: AgentProfileSession | undefined
  spaces?: AgentProfileSpaces | undefined
  targets?: Record<string, AgentProfileTarget> | undefined
}
