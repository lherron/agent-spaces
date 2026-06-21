import type { SpaceRefString } from './refs.js'
import type { ClaudeOptions, CodexOptions } from './targets.js'

export type RunMode = 'query' | 'heartbeat' | 'task' | 'maintenance'

export interface AgentIdentity {
  display?: string | undefined
  role?: string | undefined
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

export interface AgentRuntimeProfile {
  schemaVersion: 1 | 2
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
