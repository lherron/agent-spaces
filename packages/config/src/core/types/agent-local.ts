/**
 * Types for agent-local skills and commands auto-discovery.
 *
 * WHY: Agent-specific skills/ and commands/ directories are auto-discovered
 * in the agent root and materialized as a synthetic plugin. This interface
 * is the shared boundary between execution (detection) and config (materialization).
 */

/**
 * Describes agent-local skills and commands directories detected at the agent root.
 *
 * Produced by `detectAgentLocalComponents()` in execution/run.ts,
 * consumed by `materializeTarget()` in config/orchestration/install.ts.
 */
export interface AgentLocalComponents {
  /** Absolute path to the agent root directory */
  agentRoot: string
  /** Whether <agentRoot>/skills/ exists */
  hasSkills: boolean
  /** Whether <agentRoot>/commands/ exists */
  hasCommands: boolean
  /** Absolute path to <agentRoot>/skills */
  skillsDir: string
  /** Absolute path to <agentRoot>/commands */
  commandsDir: string
}
