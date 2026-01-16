import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'
import { AgentSession } from '../agent-sdk/agent-session.js'
import { PiSession } from '../pi-session/pi-session.js'
import type { PermissionHandler } from './permissions.js'
import type { SessionKind, UnifiedSession } from './types.js'

export interface CreateSessionOptions {
  kind: SessionKind
  sessionId: string
  cwd: string

  model?: 'haiku' | 'sonnet' | 'opus' | 'opus-4-5'
  allowedTools?: string[]
  plugins?: Array<{ type: 'local'; path: string }>
  systemPrompt?: string
  maxTurns?: number

  provider?: string
  providerModel?: string
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high'
  extensions?: ExtensionFactory[]
  skills?: Skill[]
  contextFiles?: Array<{ path: string; content: string }>
  agentDir?: string
  globalAgentDir?: string

  permissionHandler?: PermissionHandler
}

export function createSession(options: CreateSessionOptions): UnifiedSession {
  if (options.kind === 'agent-sdk') {
    const session = new AgentSession(
      {
        ownerId: options.sessionId,
        cwd: options.cwd,
        model: options.model ?? 'opus',
        sessionId: options.sessionId,
        ...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
        ...(options.plugins !== undefined ? { plugins: options.plugins } : {}),
        ...(options.systemPrompt !== undefined ? { systemPrompt: options.systemPrompt } : {}),
        ...(options.maxTurns !== undefined ? { maxTurns: options.maxTurns } : {}),
      },
      undefined
    )
    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }
    return session
  }

  const session = new PiSession({
    ownerId: options.sessionId,
    cwd: options.cwd,
    sessionId: options.sessionId,
    ...(options.providerModel !== undefined ? { model: options.providerModel } : {}),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.thinkingLevel !== undefined ? { thinkingLevel: options.thinkingLevel } : {}),
    ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}),
    ...(options.globalAgentDir !== undefined ? { globalAgentDir: options.globalAgentDir } : {}),
    ...(options.extensions !== undefined ? { extensions: options.extensions } : {}),
    ...(options.skills !== undefined ? { skills: options.skills } : {}),
    ...(options.contextFiles !== undefined ? { contextFiles: options.contextFiles } : {}),
  })
  if (options.permissionHandler) {
    session.setPermissionHandler(options.permissionHandler)
  }
  return session
}
