/**
 * Shared agent-profile.toml source reader.
 *
 * Centralizes the COMMON read step for the two divergent profile readers
 * (the tolerant raw-TOML reader in space-composition.ts and the schema-typed
 * reader in placement-resolver.ts). Only the file location + read is shared;
 * each caller keeps its own parse/validation step, which is where their
 * observable behavior intentionally diverges (raw parseToml tolerates inputs
 * that the typed parseAgentProfile rejects).
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Filename of the agent runtime profile, relative to an agent root. */
export const AGENT_PROFILE_FILENAME = 'agent-profile.toml'

/** Raw on-disk source for an agent profile. */
export interface AgentProfileSource {
  /** Absolute path to the profile file (used for parser error context). */
  path: string
  /** UTF-8 file contents, unparsed. */
  content: string
}

/**
 * Locate and read agent-profile.toml from an agent root.
 * Returns undefined when the file does not exist (no parsing is performed).
 */
export function readAgentProfileSource(agentRoot: string): AgentProfileSource | undefined {
  const path = join(agentRoot, AGENT_PROFILE_FILENAME)
  if (!existsSync(path)) {
    return undefined
  }
  return { path, content: readFileSync(path, 'utf8') }
}
