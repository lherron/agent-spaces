import type { ExtensionFactory, Skill } from '@mariozechner/pi-coding-agent'
import { AgentSession } from '../agent-sdk/agent-session.js'
import { CodexSession } from '../codex-session/codex-session.js'
import type { CodexApprovalPolicy, CodexSandboxMode } from '../codex-session/types.js'
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
  /** SDK session ID to resume (loads conversation history) */
  resume?: string

  provider?: string
  providerModel?: string
  thinkingLevel?: 'none' | 'low' | 'medium' | 'high'
  extensions?: ExtensionFactory[]
  skills?: Skill[]
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
        ...(options.resume !== undefined ? { resume: options.resume } : {}),
      },
      undefined
    )
    if (options.permissionHandler) {
      session.setPermissionHandler(options.permissionHandler)
    }
    return session
  }

  if (options.kind === 'codex') {
    if (!options.codexHomeDir) {
      throw new Error('codexHomeDir is required for codex sessions')
    }
    const session = new CodexSession({
      ownerId: options.sessionId,
      cwd: options.codexCwd ?? options.cwd,
      sessionId: options.sessionId,
      homeDir: options.codexHomeDir,
      ...(options.codexAppServerCommand !== undefined
        ? { appServerCommand: options.codexAppServerCommand }
        : {}),
      ...(options.codexTemplateDir !== undefined ? { templateDir: options.codexTemplateDir } : {}),
      ...(options.codexModel !== undefined ? { model: options.codexModel } : {}),
      ...(options.codexApprovalPolicy !== undefined
        ? { approvalPolicy: options.codexApprovalPolicy }
        : {}),
      ...(options.codexSandboxMode !== undefined ? { sandboxMode: options.codexSandboxMode } : {}),
      ...(options.eventsOutputPath !== undefined
        ? { eventsOutputPath: options.eventsOutputPath }
        : {}),
      ...(options.resume !== undefined ? { resumeThreadId: options.resume } : {}),
    })
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
