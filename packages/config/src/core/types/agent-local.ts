/**
 * Types for agent-local skills, commands, and tools auto-discovery.
 *
 * WHY: Agent-specific skills/, commands/, and tools/bin directories are
 * auto-discovered in the agent root. Skills and commands are materialized as a
 * synthetic plugin; tools are exposed directly at runtime.
 */

/**
 * Describes agent-local directories detected at the agent root.
 *
 * Produced by `detectAgentLocalComponents()` in execution/run.ts.
 */
export interface AgentLocalComponents {
  /** Absolute path to the agent root directory */
  agentRoot: string
  /** Basename of agentRoot */
  agentName: string
  /** Whether <agentRoot>/skills is a directory */
  hasSkills: boolean
  /** Whether <agentRoot>/commands is a directory */
  hasCommands: boolean
  /** Whether <agentRoot>/tools/bin is a directory */
  hasTools: boolean
  /** Absolute path to <agentRoot>/skills */
  skillsDir: string
  /** Absolute path to <agentRoot>/commands */
  commandsDir: string
  /** Absolute path to <agentRoot>/tools */
  toolsDir: string
  /** Absolute path to <agentRoot>/tools/bin */
  toolsBinDir: string
  /** Absolute path to <agentRoot>/var */
  agentVarDir: string
}
