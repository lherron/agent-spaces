import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  CLAUDE_DESKTOP_PARTICIPANT_CLASS,
  createClaudeDesktopParticipantAdapter,
} from 'agent-spaces'
import { writeClaudeCallerEnv } from './desktop-join-claude-env.js'
import { desktopStatePaths } from './desktop-join-thread.js'
import type { DesktopJoinClient } from './desktop-join.js'
import { desktopScopeRef } from './desktop-project.js'
import { createClaudeDesktopDriver } from './drivers/claude-desktop/driver.js'

const AGENT_ID = 'vega'

export function createClaudeDesktopJoinClient(input: {
  claudeHome: string
  sessionId: string
  pid?: number | undefined
}): DesktopJoinClient {
  const { sessionId, pid } = input
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid Claude Desktop session ID')
  const claudeHome = resolve(input.claudeHome)
  const classId = CLAUDE_DESKTOP_PARTICIPANT_CLASS
  const adapter = createClaudeDesktopParticipantAdapter()
  return {
    sessionId,
    classId,
    agentId: AGENT_ID,
    fallbackProjectId: 'praesidium',
    cacheIdentity: { sessionId },
    statePaths: () => desktopStatePaths(claudeHome, sessionId),
    adapter,
    scopeRefs: (projectId) => [desktopScopeRef(AGENT_ID, projectId, `claude-${sessionId}`)],
    createDriver: () => createClaudeDesktopDriver({ sessionId, claudeHome }),
    onJoined: (paths, joined) => writeClaudeCallerEnv(paths.stateDir, sessionId, joined),
    async admit() {
      if (pid === undefined || !Number.isSafeInteger(pid) || pid < 2) {
        return { admitted: false, reason: 'claude_desktop_pid_missing_or_invalid' }
      }
      let row: unknown
      try {
        row = JSON.parse(await readFile(join(claudeHome, 'sessions', `${pid}.json`), 'utf8'))
      } catch {
        return { admitted: false, reason: 'claude_desktop_registry_row_unavailable' }
      }
      if (typeof row !== 'object' || row === null || Array.isArray(row)) {
        return { admitted: false, reason: 'claude_desktop_registry_row_invalid' }
      }
      const record = row as Record<string, unknown>
      const stringOrNull = (value: unknown) => (typeof value === 'string' ? value : null)
      const admission = await adapter.admit({
        classId,
        join: 'participant-served',
        evidence: {
          requestedSessionId: sessionId,
          sessionId: stringOrNull(record['sessionId']),
          entrypoint: stringOrNull(record['entrypoint']),
          cwd: stringOrNull(record['cwd']),
        },
      })
      if (admission.status !== 'admitted') return { admitted: false, reason: admission.reason }
      const { preparation, participantKey, workspaceCwd } = admission
      return { admitted: true, preparation, participantKey, workspaceCwd, homeIdentity: claudeHome }
    },
  }
}
