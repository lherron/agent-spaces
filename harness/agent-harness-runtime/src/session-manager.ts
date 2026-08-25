import { join } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

/** Foreground histories are isolated per ASP agent and Pi further scopes them by cwd. */
export function createAgentSessionManager(options: {
  aspHome: string
  agentId: string
  cwd: string
  continuationKey?: string | undefined
}): SessionManager {
  const sessionDir = join(options.aspHome, 'agent-harness', 'sessions', options.agentId)
  return options.continuationKey === undefined
    ? SessionManager.create(options.cwd, sessionDir)
    : SessionManager.open(options.continuationKey, sessionDir, options.cwd)
}
