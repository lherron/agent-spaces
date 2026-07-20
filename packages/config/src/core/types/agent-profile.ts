import type { SpaceRefString } from './refs.js'
import type { ClaudeOptions, CodexOptions } from './targets.js'

export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export interface AgentIdentity {
  display?: string | undefined
  /** Descriptive profile metadata; parsed but currently consumed nowhere. */
  role?: string | undefined
  /** Default role used by scope resolution for task-bearing handles that omit a role. */
  default_scope_role?: string | undefined
  harness?: string | undefined
}

export interface HarnessSettings {
  model?: string | undefined
  sandboxMode?: string | undefined
  approvalPolicy?: string | undefined
  profile?: string | undefined
  yolo?: boolean | undefined
  remote_control?: boolean | undefined
  claude?: ClaudeOptions | undefined
  codex?: CodexOptions | undefined
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

export interface AgentProfileSession {
  additionalContext?: string[] | undefined
  additionalExec?: string[] | undefined
}

/** Source-shaped federation placement declaration from agent-profile.toml. */
export interface AgentProfilePlacement {
  default_home_node?: string | undefined
  pins: Record<string, string>
  task_defaults?: Record<string, string> | undefined
}

export interface AgentRuntimeProfile {
  schemaVersion: 1 | 2
  claims_task?: boolean | undefined
  placement?: AgentProfilePlacement | undefined
  identity?: AgentIdentity | undefined
  priming_prompt?: string | undefined
  priming_prompt_file?: string | undefined
  instructions?: AgentProfileInstructions | undefined
  session?: AgentProfileSession | undefined
  spaces?: AgentProfileSpaces | undefined
  targets?: Record<string, AgentProfileTarget> | undefined
  harnessDefaults?: HarnessSettings | undefined
  harnessByMode?: Partial<Record<RunMode, HarnessSettings>> | undefined
}
