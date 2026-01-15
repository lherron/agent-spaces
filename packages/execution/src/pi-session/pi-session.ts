import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AuthStorage,
  SessionManager,
  createAgentSession,
  discoverModels,
} from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'
import type {
  PiAgentSessionEvent,
  PiSessionConfig,
  PiSessionStartOptions,
  PiSessionState,
} from './types.js'

function hasCredentials(path: string): boolean {
  if (!existsSync(path)) return false
  try {
    const raw = readFileSync(path, 'utf8').trim()
    if (!raw) return false
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(parsed).length > 0
  } catch {
    return false
  }
}

function resolveAuthStoragePath(globalAgentDir: string): string {
  const authPath = join(globalAgentDir, 'auth.json')
  const oauthPath = join(globalAgentDir, 'oauth.json')
  if (hasCredentials(authPath)) return authPath
  if (hasCredentials(oauthPath)) return oauthPath
  if (existsSync(authPath)) return authPath
  if (existsSync(oauthPath)) return oauthPath
  return authPath
}

export class PiSession {
  private state: PiSessionState = 'idle'
  private lastActivityAt = Date.now()
  private sessionId: string
  private currentRunId?: string
  private agentSession: AgentSession | null = null
  private unsubscribe: (() => void) | undefined

  constructor(private readonly config: PiSessionConfig) {
    this.sessionId = config.sessionId ?? `pi-${config.ownerId}-${Date.now()}`
  }

  async start(options: PiSessionStartOptions = {}): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error(`Cannot start session in state: ${this.state}`)
    }

    try {
      const agentDir = options.agentDir ?? this.config.agentDir
      const globalAgentDir =
        options.globalAgentDir ??
        this.config.globalAgentDir ??
        process.env['PI_CODING_AGENT_DIR'] ??
        join(homedir(), '.pi', 'agent')

      const authStorage = new AuthStorage(resolveAuthStoragePath(globalAgentDir))
      const modelRegistry = discoverModels(authStorage, globalAgentDir)

      let model = undefined
      if (this.config.model && this.config.provider) {
        const found = modelRegistry.find(this.config.provider, this.config.model)
        model = found ?? undefined
        if (!model) {
          console.warn(
            `[pi-session] Model not found: ${this.config.provider}:${this.config.model}. Falling back to defaults.`
          )
        }
      }

      const sessionManager =
        this.config.persistSessions === false
          ? SessionManager.inMemory()
          : this.config.sessionPath
            ? SessionManager.create(this.config.sessionPath)
            : SessionManager.create(this.config.cwd)

      const extensions = options.extensions ?? []
      const skills = options.skills ?? []
      const contextFiles = options.contextFiles ?? []

      const appendPrompt = this.config.systemPrompt

      const sessionOptions = {
        cwd: this.config.cwd,
        thinkingLevel: this.mapThinkingLevel(this.config.thinkingLevel),
        authStorage,
        modelRegistry,
        additionalExtensionPaths: [...(this.config.additionalExtensionPaths ?? [])],
        skills,
        extensions,
        contextFiles,
        sessionManager,
      } as NonNullable<Parameters<typeof createAgentSession>[0]>

      if (agentDir) {
        sessionOptions.agentDir = agentDir
      }
      if (model) {
        sessionOptions.model = model
      }
      if (appendPrompt) {
        sessionOptions.systemPrompt = (defaultPrompt: string) =>
          `${defaultPrompt}\n\n${appendPrompt}`
      }

      const { session } = await createAgentSession(sessionOptions)

      this.agentSession = session
      this.subscribeToEvents()
      this.state = 'running'
      this.lastActivityAt = Date.now()
    } catch (error) {
      this.state = 'error'
      throw error
    }
  }

  async sendPrompt(text: string, runId?: string): Promise<void> {
    if (this.state !== 'running' || !this.agentSession) {
      throw new Error(`Cannot send prompt in state: ${this.state}`)
    }

    this.lastActivityAt = Date.now()
    this.state = 'streaming'

    try {
      this.currentRunId = runId ?? `run-${Date.now()}`
      await this.agentSession.prompt(text)
    } catch (error) {
      console.error('[pi-session] Error in sendPrompt:', error)
      throw error
    } finally {
      this.state = 'running'
    }
  }

  async stop(reason?: string): Promise<void> {
    if (this.state === 'stopped') return

    if (this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = undefined
    }

    if (this.agentSession) {
      this.agentSession.abort()
    }

    if (this.config.hookEventBus) {
      this.config.hookEventBus.emitHook(this.config.ownerId, {
        hook_event_name: 'SessionEnd',
        reason,
        cwd: this.config.cwd,
      })
    }

    this.state = 'stopped'
  }

  isHealthy(): boolean {
    return this.state === 'running' || this.state === 'streaming'
  }

  getSessionId(): string {
    return this.sessionId
  }

  getLastActivityAt(): number {
    return this.lastActivityAt
  }

  getState(): PiSessionState {
    return this.state
  }

  private mapThinkingLevel(
    level?: 'none' | 'low' | 'medium' | 'high'
  ): 'off' | 'low' | 'medium' | 'high' {
    if (!level || level === 'none') {
      return 'off'
    }
    return level
  }

  private subscribeToEvents(): void {
    if (!this.agentSession) {
      console.warn('[pi-session] AgentSession not available')
      return
    }

    this.unsubscribe = this.agentSession.subscribe((event) => {
      this.lastActivityAt = Date.now()
      const piEvent = event as PiAgentSessionEvent
      if (this.config.onEvent) {
        this.config.onEvent(piEvent, this.currentRunId)
      }
      this.emitHookForEvent(piEvent)
    })
  }

  private emitHookForEvent(event: PiAgentSessionEvent): void {
    if (!this.config.hookEventBus) return

    switch (event.type) {
      case 'tool_execution_start':
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: 'PreToolUse',
          tool_name: event.toolName,
          tool_input: event.args,
          tool_use_id: event.toolCallId,
          cwd: this.config.cwd,
          session_id: this.sessionId,
        })
        break

      case 'tool_execution_end':
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: 'PostToolUse',
          tool_name: event.toolName,
          tool_input: event.args,
          tool_response: event.result,
          tool_use_id: event.toolCallId,
          is_error: event.isError,
          cwd: this.config.cwd,
          session_id: this.sessionId,
        })
        break

      case 'agent_end':
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: 'Stop',
          cwd: this.config.cwd,
          session_id: this.sessionId,
        })
        break
    }
  }
}
