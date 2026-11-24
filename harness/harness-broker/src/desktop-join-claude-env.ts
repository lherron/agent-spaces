import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWrite } from 'spaces-config/core'
import type { JoinedRecord } from './desktop-join-thread.js'
import { shellQuote } from './runtime/shell-quote.js'

const callerEnvFile = 'caller-env.sh'

export function claudeDesktopProjectId(scope: unknown, sessionId: string): string | undefined {
  if (typeof scope !== 'string') return undefined
  const match = /^agent:vega:project:([^:]+):task:(.+)$/.exec(scope)
  if (match?.[2] === `claude-${sessionId}`) return match[1]
}

export function installClaudeCallerEnvSource(envFile: string, stateDir: string): void {
  const file = shellQuote(join(stateDir, callerEnvFile))
  // Claude caches this snippet, but executes it for each Bash tool call.
  appendFileSync(envFile, `\nif [ -r ${file} ]; then . ${file}; fi\n`, { mode: 0o600 })
}

export async function writeClaudeCallerEnv(
  stateDir: string,
  sessionId: string,
  joined: JoinedRecord
): Promise<void> {
  const projectId = claudeDesktopProjectId(joined.scopeRef, sessionId)
  const lane = joined.laneRef.replace(/^lane:/, '')
  if (!projectId || !joined.runtimeId || !lane) {
    throw new Error('Incomplete Claude Desktop join identity')
  }
  const env = {
    AGENT_LANE: lane,
    HRC_SESSION_REF: `${joined.scopeRef}/lane:${lane}`,
    HRC_RUNTIME_ID: joined.runtimeId,
    ASP_AGENT_ID: 'vega',
    ASP_PROJECT: projectId,
    ASP_SCOPE_REF: joined.scopeRef,
    ASP_TASK_ID: `claude-${sessionId}`,
  }
  const exports = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`)
  const source = `if kill -0 ${process.pid} 2>/dev/null; then\n  export ${exports.join(' ')}\nfi\n`
  await atomicWrite(join(stateDir, callerEnvFile), source, { mode: 0o600 })
}
