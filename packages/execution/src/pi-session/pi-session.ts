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
import type { PermissionHandler } from '../session/permissions.js'
import type {
  ContentBlock,
  Message,
  PromptOptions,
  ToolResult,
  UnifiedSession,
  UnifiedSessionEvent,
  UnifiedSessionState,
} from '../session/types.js'
import { createPermissionHook } from './permission-hook.js'
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

export class PiSession implements UnifiedSession {
  readonly kind = 'pi' as const
  private state: PiSessionState = 'idle'
  private lastActivityAt = Date.now()
  readonly sessionId: string
  private currentRunId?: string
  private agentSession: AgentSession | null = null
  private unsubscribe: (() => void) | undefined
  private eventCallback?: (event: UnifiedSessionEvent) => void
  private permissionHandler?: PermissionHandler

  constructor(private readonly config: PiSessionConfig) {
    this.sessionId = config.sessionId ?? `pi-${config.ownerId}-${Date.now()}`
  }

  onEvent(callback: (event: UnifiedSessionEvent) => void): void {
    this.eventCallback = callback
  }

  setPermissionHandler(handler: PermissionHandler): void {
    this.permissionHandler = handler
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

      const extensionOverrides = options.extensions ?? this.config.extensions ?? []
      const permissionHook = this.permissionHandler
        ? createPermissionHook({
            ownerId: this.config.ownerId,
            ...(this.config.hookEventBus ? { hookEventBus: this.config.hookEventBus } : {}),
            permissionHandler: this.permissionHandler,
            sessionId: this.sessionId,
            cwd: this.config.cwd,
          })
        : undefined
      const extensions = permissionHook
        ? [permissionHook, ...extensionOverrides]
        : extensionOverrides
      const skills = options.skills ?? this.config.skills ?? []
      const contextFiles = options.contextFiles ?? this.config.contextFiles ?? []

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

  async sendPrompt(text: string, options?: PromptOptions): Promise<void> {
    if (this.state !== 'running' || !this.agentSession) {
      throw new Error(`Cannot send prompt in state: ${this.state}`)
    }

    this.lastActivityAt = Date.now()
    this.state = 'streaming'

    try {
      const runId = typeof (options as unknown) === 'string' ? (options as string) : options?.runId
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

  getState(): UnifiedSessionState {
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
      const unifiedEvents = mapPiEventToUnified(piEvent, this.sessionId)
      for (const unifiedEvent of unifiedEvents) {
        this.eventCallback?.(unifiedEvent)
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

interface PiMessage {
  role: 'user' | 'assistant' | 'toolResult'
  content: PiContentBlock[] | string
  toolCallId?: string
  toolName?: string
  isError?: boolean
  details?: Record<string, unknown>
  usage?: {
    input?: number
    output?: number
    totalTokens?: number
  }
  stopReason?: string
}

type PiContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'media_ref'; url: string; mimeType?: string; filename?: string; alt?: string }

interface PiAssistantMessageEvent {
  type:
    | 'text_start'
    | 'text_delta'
    | 'text_end'
    | 'thinking_start'
    | 'thinking_delta'
    | 'thinking_end'
    | 'toolcall_start'
    | 'toolcall_delta'
    | 'toolcall_end'
  text?: string
  delta?: string
  content?: string
  thinking?: string
  toolCallId?: string
  toolName?: string
  arguments?: Record<string, unknown>
}

function mapPiEventToUnified(
  piEvent: PiAgentSessionEvent,
  sessionId: string
): UnifiedSessionEvent[] {
  switch (piEvent.type) {
    case 'agent_start':
      return [{ type: 'agent_start', sessionId }]
    case 'agent_end': {
      const reason = typeof piEvent.reason === 'string' ? piEvent.reason : undefined
      return [
        {
          type: 'agent_end',
          sessionId,
          ...(reason !== undefined ? { reason } : {}),
        },
      ]
    }
    case 'turn_start': {
      const turnId = typeof piEvent.turnId === 'string' ? piEvent.turnId : undefined
      return [
        {
          type: 'turn_start',
          ...(turnId !== undefined ? { turnId } : {}),
        },
      ]
    }
    case 'turn_end': {
      const turnId = typeof piEvent.turnId === 'string' ? piEvent.turnId : undefined
      const rawToolResults = Array.isArray(piEvent.toolResults) ? piEvent.toolResults : []
      const toolResults = rawToolResults.map((tr: unknown) => {
        const result = tr as { toolUseId?: string; result?: unknown }
        return {
          toolUseId: result.toolUseId ?? '',
          result: mapToolResultContent(result.result),
        }
      })
      return [
        {
          type: 'turn_end',
          ...(turnId !== undefined ? { turnId } : {}),
          ...(toolResults.length > 0 ? { toolResults } : {}),
        },
      ]
    }
    case 'message_start': {
      const message = mapPiMessage(piEvent.message as PiMessage | undefined)
      if (!message) return []
      const messageId = typeof piEvent.messageId === 'string' ? piEvent.messageId : undefined
      return [
        {
          type: 'message_start',
          message,
          ...(messageId !== undefined ? { messageId } : {}),
        },
      ]
    }
    case 'message_update': {
      const messageId = typeof piEvent.messageId === 'string' ? piEvent.messageId : undefined
      const event: UnifiedSessionEvent = {
        type: 'message_update',
        ...(messageId !== undefined ? { messageId } : {}),
      }
      const assistantMessageEvent = piEvent.assistantMessageEvent as
        | PiAssistantMessageEvent
        | undefined
      if (assistantMessageEvent) {
        if (assistantMessageEvent.type === 'text_delta') {
          const delta = assistantMessageEvent.delta ?? assistantMessageEvent.text
          if (delta) {
            ;(event as { textDelta?: string }).textDelta = delta
          }
        } else if (assistantMessageEvent.type === 'text_end' && assistantMessageEvent.content) {
          ;(event as { contentBlocks?: ContentBlock[] }).contentBlocks = [
            { type: 'text', text: assistantMessageEvent.content },
          ]
        }
      }

      const message = piEvent.message as PiMessage | undefined
      if (message?.content && Array.isArray(message.content)) {
        ;(event as { contentBlocks?: ContentBlock[] }).contentBlocks = mapContentBlocks(
          message.content
        )
      }

      return [event as UnifiedSessionEvent]
    }
    case 'message_end': {
      const message = mapPiMessage(piEvent.message as PiMessage | undefined)
      const messageId = typeof piEvent.messageId === 'string' ? piEvent.messageId : undefined
      return [
        {
          type: 'message_end',
          ...(messageId !== undefined ? { messageId } : {}),
          ...(message !== undefined ? { message } : {}),
        },
      ]
    }
    case 'tool_execution_start':
      return [
        {
          type: 'tool_execution_start',
          toolUseId: piEvent.toolCallId ?? '',
          toolName: piEvent.toolName ?? '',
          input: normalizeToolInput(piEvent.args),
        },
      ]
    case 'tool_execution_update':
      return [
        {
          type: 'tool_execution_update',
          toolUseId: piEvent.toolCallId ?? '',
          ...(piEvent.partialResult !== undefined
            ? { partialOutput: String(piEvent.partialResult) }
            : {}),
        },
      ]
    case 'tool_execution_end':
      return [
        {
          type: 'tool_execution_end',
          toolUseId: piEvent.toolCallId ?? '',
          toolName: piEvent.toolName ?? '',
          result: mapToolResultContent(piEvent.result),
          ...(piEvent.isError !== undefined ? { isError: piEvent.isError } : {}),
        },
      ]
    default:
      return []
  }
}

function mapPiMessage(piMessage: PiMessage | undefined): Message | undefined {
  if (!piMessage) return undefined
  let content: ContentBlock[] | string
  if (typeof piMessage.content === 'string') {
    content = piMessage.content
  } else {
    content = mapContentBlocks(piMessage.content)
  }
  return {
    role: piMessage.role,
    content,
  }
}

function mapContentBlocks(piBlocks: PiContentBlock[]): ContentBlock[] {
  return piBlocks
    .filter(
      (
        block
      ): block is
        | { type: 'text'; text: string }
        | { type: 'image'; data: string; mimeType: string }
        | { type: 'media_ref'; url: string; mimeType?: string; filename?: string; alt?: string }
        | { type: 'toolCall'; id: string; name: string; arguments: Record<string, unknown> } => {
        return (
          block.type === 'text' ||
          block.type === 'image' ||
          block.type === 'media_ref' ||
          block.type === 'toolCall'
        )
      }
    )
    .map((block): ContentBlock => {
      if (block.type === 'text') {
        return { type: 'text', text: block.text }
      }
      if (block.type === 'image') {
        return { type: 'image', data: block.data, mimeType: block.mimeType }
      }
      if (block.type === 'media_ref') {
        return {
          type: 'media_ref',
          url: block.url,
          ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
          ...(typeof block.filename === 'string' ? { filename: block.filename } : {}),
          ...(typeof block.alt === 'string' ? { alt: block.alt } : {}),
        }
      }
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.arguments,
      }
    })
}

function mapToolResultContent(result: unknown): ToolResult {
  let content: ContentBlock[]
  if (typeof result === 'string') {
    content = [{ type: 'text', text: result }]
  } else if (Array.isArray(result)) {
    content = result.map((item: unknown) => {
      if (typeof item === 'object' && item !== null && 'type' in item) {
        const block = item as {
          type: string
          text?: string
          data?: string
          mimeType?: string
          url?: string
          filename?: string
          alt?: string
        }
        if (block.type === 'image' && block.data && block.mimeType) {
          return { type: 'image', data: block.data, mimeType: block.mimeType }
        }
        if (block.type === 'media_ref' && block.url) {
          return {
            type: 'media_ref',
            url: block.url,
            ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
            ...(typeof block.filename === 'string' ? { filename: block.filename } : {}),
            ...(typeof block.alt === 'string' ? { alt: block.alt } : {}),
          }
        }
        if (block.type === 'text' && block.text !== undefined) {
          return { type: 'text', text: block.text }
        }
        return item as ContentBlock
      }
      return { type: 'text', text: String(item) }
    })
  } else if (typeof result === 'object' && result !== null) {
    const obj = result as { content?: unknown }
    const objContent = obj.content
    if (Array.isArray(objContent)) {
      content = objContent.map((item: unknown) => {
        if (typeof item === 'object' && item !== null && 'type' in item) {
          const block = item as {
            type: string
            text?: string
            data?: string
            mimeType?: string
            url?: string
            filename?: string
            alt?: string
          }
          if (block.type === 'image' && block.data && block.mimeType) {
            return { type: 'image', data: block.data, mimeType: block.mimeType }
          }
          if (block.type === 'media_ref' && block.url) {
            return {
              type: 'media_ref',
              url: block.url,
              ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}),
              ...(typeof block.filename === 'string' ? { filename: block.filename } : {}),
              ...(typeof block.alt === 'string' ? { alt: block.alt } : {}),
            }
          }
          if (block.type === 'text' && block.text !== undefined) {
            return { type: 'text', text: block.text }
          }
        }
        return item as ContentBlock
      })
    } else {
      content = [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    }
  } else {
    content = [{ type: 'text', text: String(result) }]
  }

  return { content }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>
  }
  if (input === undefined) return {}
  return { value: input }
}
