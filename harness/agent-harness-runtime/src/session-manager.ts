import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

import { SessionManager } from '@earendil-works/pi-coding-agent'

/** Foreground histories are isolated per ASP agent and Pi further scopes them by cwd. */
export function createAgentSessionManager(options: {
  aspHome: string
  agentId: string
  cwd: string
  continuationKey?: string | boolean | undefined
}): SessionManager {
  const sessionDir = join(options.aspHome, 'agent-harness', 'sessions', options.agentId)
  if (options.continuationKey === undefined) {
    return SessionManager.create(options.cwd, sessionDir)
  }
  if (options.continuationKey === true) {
    return SessionManager.continueRecent(options.cwd, sessionDir)
  }
  if (options.continuationKey === false) {
    return SessionManager.create(options.cwd, sessionDir)
  }
  return SessionManager.open(
    resolveAgentSessionPath(sessionDir, options.continuationKey),
    sessionDir,
    options.cwd
  )
}

/** Explicit sessions are constrained to the selected agent's history directory. */
export function resolveAgentSessionPath(sessionDir: string, continuationKey: string): string {
  const root = existsSync(sessionDir) ? realpathSync(sessionDir) : resolve(sessionDir)
  const candidate = isAbsolute(continuationKey)
    ? resolve(continuationKey)
    : resolve(sessionDir, continuationKey)
  const canonical = existsSync(candidate) ? realpathSync(candidate) : candidate
  const rel = relative(root, canonical)
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Session ${continuationKey} is outside the selected agent session directory`)
  }
  if (!existsSync(canonical)) {
    throw new Error(`Session ${continuationKey} was not found for the selected agent`)
  }
  return canonical
}
