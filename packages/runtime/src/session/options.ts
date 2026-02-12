import type { PermissionHandler } from './permissions.js'
import type { SessionKind } from './types.js'

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CreateSessionOptions {
  kind: SessionKind
  sessionId: string
  cwd: string

  model?: 'haiku' | 'sonnet' | 'opus' | 'opus-4-6'
  allowedTools?: string[]
  plugins?: Array<{ type: 'local'; path: string }>
  systemPrompt?: string
  maxTurns?: number
  /** SDK session ID to resume (loads conversation history) */
  resume?: string

  provider?: string
  providerModel?: string
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high'
  extensions?: unknown[]
  skills?: unknown[]
  contextFiles?: Array<{ path: string; content: string }>
  agentDir?: string
  globalAgentDir?: string

  codexAppServerCommand?: string
  codexHomeDir?: string
  codexTemplateDir?: string
  codexModel?: string
  codexCwd?: string
  codexApprovalPolicy?: CodexApprovalPolicy
  codexSandboxMode?: CodexSandboxMode
  eventsOutputPath?: string

  permissionHandler?: PermissionHandler
}
