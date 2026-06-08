import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  createAgentSession,
} from '@mariozechner/pi-coding-agent'
import type { AgentSession } from '@mariozechner/pi-coding-agent'
import type {
  ContentBlock,
  Message,
  PermissionHandler,
  PromptOptions,
  SessionMetadataSnapshot,
  ToolResult,
  UnifiedSession,
  UnifiedSessionEvent,
  UnifiedSessionState,
} from 'spaces-runtime'
import { HOOK_EVENT, PI_EVENT } from './event-types.js'
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

/**
 * Resolve the Pi global agent directory using start-option, config, env, and
 * homedir precedence (in that order). Pure: depends only on its inputs plus the
 * process env / homedir defaults.
 */
function resolveGlobalAgentDir(
  optionsGlobalAgentDir: string | undefined,
  configGlobalAgentDir: string | undefined
): string {
  return (
    optionsGlobalAgentDir ??
    configGlobalAgentDir ??
    process.env['PI_CODING_AGENT_DIR'] ??
    join(homedir(), '.pi', 'agent')
  )
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
  private readonly eventMappingState: PiEventMappingState = createPiEventMappingState()

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
      const globalAgentDir = resolveGlobalAgentDir(
        options.globalAgentDir,
        this.config.globalAgentDir
      )

      const authStorage = AuthStorage.create(resolveAuthStoragePath(globalAgentDir))
      const modelsJsonPath = join(globalAgentDir, 'models.json')
      const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath)

      const model = this.resolveModel(modelRegistry)
      const sessionManager = this.createSessionManager()

      const sessionOptions: NonNullable<Parameters<typeof createAgentSession>[0]> = {
        cwd: this.config.cwd,
        thinkingLevel: this.mapThinkingLevel(this.config.thinkingLevel),
        authStorage,
        modelRegistry,
        sessionManager,
      }

      if (agentDir) {
        sessionOptions.agentDir = agentDir
      }
      if (model) {
        sessionOptions.model = model
      }

      const { session } = await createAgentSession(sessionOptions)

      this.agentSession = session
      this.subscribeToEvents()
      this.state = 'running'
      this.lastActivityAt = Date.now()
    } catch (error) {
      console.error('[pi-session] Start failed:', error)
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
      this.currentRunId = options?.runId ?? `run-${Date.now()}`
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
        hook_event_name: HOOK_EVENT.SESSION_END,
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

  getMetadata(): SessionMetadataSnapshot {
    return {
      sessionId: this.sessionId,
      kind: this.kind,
      state: this.getState(),
      lastActivityAt: this.lastActivityAt,
      capabilities: {
        supportsInterrupt: false,
        supportsInFlightInput: false,
        supportsNativeResume: false,
        supportsAttach: false,
      },
    }
  }

  private mapThinkingLevel(
    level?: 'none' | 'low' | 'medium' | 'high'
  ): 'off' | 'low' | 'medium' | 'high' {
    if (!level || level === 'none') {
      return 'off'
    }
    return level
  }

  private resolveModel(
    modelRegistry: ModelRegistry
  ): ReturnType<ModelRegistry['find']> | undefined {
    if (!this.config.model || !this.config.provider) {
      return undefined
    }
    const found = modelRegistry.find(this.config.provider, this.config.model)
    if (!found) {
      console.warn(
        `[pi-session] Model not found: ${this.config.provider}:${this.config.model}. Falling back to defaults.`
      )
      return undefined
    }
    return found
  }

  private createSessionManager(): SessionManager {
    if (this.config.persistSessions === false) {
      return SessionManager.inMemory()
    }
    if (this.config.sessionPath) {
      return SessionManager.create(this.config.sessionPath)
    }
    return SessionManager.create(this.config.cwd)
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
      const unifiedEvents = mapPiEventToUnified(piEvent, this.sessionId, this.eventMappingState)
      for (const unifiedEvent of unifiedEvents) {
        this.eventCallback?.(unifiedEvent)
      }
      this.emitHookForEvent(piEvent)
    })
  }

  private emitHookForEvent(event: PiAgentSessionEvent): void {
    if (!this.config.hookEventBus) return

    switch (event.type) {
      case PI_EVENT.TOOL_EXECUTION_START:
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: HOOK_EVENT.PRE_TOOL_USE,
          tool_name: event.toolName,
          tool_input: event.args,
          tool_use_id: event.toolCallId,
          cwd: this.config.cwd,
          session_id: this.sessionId,
        })
        break

      case PI_EVENT.TOOL_EXECUTION_END:
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: HOOK_EVENT.POST_TOOL_USE,
          tool_name: event.toolName,
          tool_input: event.args,
          tool_response: event.result,
          tool_use_id: event.toolCallId,
          is_error: event.isError,
          cwd: this.config.cwd,
          session_id: this.sessionId,
        })
        break

      case PI_EVENT.AGENT_END:
        this.config.hookEventBus.emitHook(this.config.ownerId, {
          hook_event_name: HOOK_EVENT.STOP,
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

interface HeldAssistantMessage {
  message: Message
  messageId?: string
}

export interface PiEventMappingState {
  /**
   * Latest assistant message observed via an SDK message_end callback that has
   * NOT yet been surfaced. Held-latest: the pi SDK reports message completion
   * before turn completion, so we hold the message and only emit it once we
   * know whether it is terminal-for-turn (final:true) or superseded by more
   * tool/assistant work (final:false).
   */
  held?: HeldAssistantMessage | undefined
  /**
   * True between agent_start and agent_end. The pi SDK's turn_start/turn_end are
   * native MODEL-ROUND boundaries, NOT operator-turn boundaries: a single prompt
   * drives multiple native turns. While the agent lifecycle is active, a native
   * turn_end is INTERNAL — the held message is not yet known to be terminal, so
   * it carries across rounds (a later message_end supersedes it as final:false)
   * and only agent_end (the operator terminal) finalizes the last held message as
   * final:true. With NO agent lifecycle (bare/legacy callers), a standalone
   * turn_end remains the terminal boundary and finalizes final:true.
   */
  agentActive?: boolean | undefined
}

export function createPiEventMappingState(): PiEventMappingState {
  return {}
}

function assistantTextFromPiMessage(piMessage: PiMessage | undefined): string | undefined {
  if (!piMessage || piMessage.role !== 'assistant') return undefined
  if (typeof piMessage.content === 'string') {
    return piMessage.content.trim().length > 0 ? piMessage.content : undefined
  }

  const text = piMessage.content
    .filter((block): block is { type: 'text'; text: string } => {
      return block.type === 'text' && typeof block.text === 'string'
    })
    .map((block) => block.text)
    .join('')

  return text.trim().length > 0 ? text : undefined
}

function latestAssistantMessage(messages: unknown): PiMessage | undefined {
  if (!Array.isArray(messages)) return undefined

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as PiMessage | undefined
    if (assistantTextFromPiMessage(message) !== undefined) {
      return message
    }
  }

  return undefined
}

/**
 * Build a held-latest entry from a pi message if it is an assistant message
 * with real text content; otherwise undefined (e.g. an empty turn_end fallback,
 * which must preserve true empty-response detection).
 */
function heldFromPiMessage(
  piMessage: PiMessage | undefined,
  messageId: string | undefined
): HeldAssistantMessage | undefined {
  if (assistantTextFromPiMessage(piMessage) === undefined) return undefined
  const message = mapPiMessage(piMessage)
  if (!message) return undefined
  return { message, ...(messageId !== undefined ? { messageId } : {}) }
}

function messageEndEvent(held: HeldAssistantMessage, final: boolean): UnifiedSessionEvent {
  return {
    type: 'message_end',
    ...(held.messageId !== undefined ? { messageId: held.messageId } : {}),
    message: held.message,
    payload: { final },
  }
}

/** Flush the held message (if any) with the given terminal-for-turn flag. */
function flushHeld(state: PiEventMappingState, final: boolean): UnifiedSessionEvent[] {
  const held = state.held
  if (!held) return []
  state.held = undefined
  return [messageEndEvent(held, final)]
}

/**
 * Terminal flush for turn_end / agent_end. Prefer the held message (the latest
 * observed message_end, which is the terminal answer for the turn); fall back
 * to a terminal message carried directly on the terminal event when nothing was
 * held (e.g. turn_end with an inline assistant message).
 */
function flushTerminal(
  state: PiEventMappingState,
  fallback: HeldAssistantMessage | undefined
): UnifiedSessionEvent[] {
  if (state.held) return flushHeld(state, true)
  if (!fallback) return []
  return [messageEndEvent(fallback, true)]
}

function handleAgentEnd(
  piEvent: PiAgentSessionEvent,
  sessionId: string,
  state: PiEventMappingState
): UnifiedSessionEvent[] {
  const reason = typeof piEvent.reason === 'string' ? piEvent.reason : undefined
  // Operator terminal: finalize the last held assistant message as
  // final:true (falling back to the latest assistant message in the
  // agent_end payload when nothing is held).
  const flush = flushTerminal(
    state,
    heldFromPiMessage(latestAssistantMessage(piEvent['messages']), undefined)
  )
  state.agentActive = false
  return [
    ...flush,
    {
      type: 'agent_end',
      sessionId,
      ...(reason !== undefined ? { reason } : {}),
    },
  ]
}

function handleTurnEnd(
  piEvent: PiAgentSessionEvent,
  state: PiEventMappingState
): UnifiedSessionEvent[] {
  const turnId = typeof piEvent.turnId === 'string' ? piEvent.turnId : undefined
  const rawToolResults = Array.isArray(piEvent.toolResults) ? piEvent.toolResults : []
  const toolResults = rawToolResults.map((tr: unknown) => {
    const result = tr as { toolUseId?: string; result?: unknown }
    return {
      toolUseId: result.toolUseId ?? '',
      result: mapToolResultContent(result.result),
    }
  })
  // Inside an agent lifecycle, a native turn_end is an INTERNAL model-round
  // boundary: the held message carries forward (a later message_end
  // supersedes it as final:false; agent_end finalizes the last as
  // final:true). A BARE turn_end (no agent lifecycle) is itself the terminal
  // boundary and finalizes the held/inline assistant message as final:true.
  const flush = state.agentActive
    ? []
    : flushTerminal(
        state,
        heldFromPiMessage(
          piEvent.message as PiMessage | undefined,
          typeof piEvent.messageId === 'string' ? piEvent.messageId : undefined
        )
      )
  return [
    ...flush,
    {
      type: 'turn_end',
      ...(turnId !== undefined ? { turnId } : {}),
      ...(toolResults.length > 0 ? { toolResults } : {}),
    },
  ]
}

function handleMessageEnd(
  piEvent: PiAgentSessionEvent,
  state: PiEventMappingState
): UnifiedSessionEvent[] {
  const piMessage = piEvent.message as PiMessage | undefined
  const messageId = typeof piEvent.messageId === 'string' ? piEvent.messageId : undefined
  const newHeld = heldFromPiMessage(piMessage, messageId)
  if (newHeld) {
    // Held-latest: the SDK reports this assistant message as complete, but
    // we don't yet know whether it is terminal-for-turn. Flush the prior
    // held message as a non-final intermediate, then hold this one until a
    // turn/agent terminal (final:true) or the next message_end supersedes it.
    const flushed = flushHeld(state, false)
    state.held = newHeld
    return flushed
  }
  // An assistant message with no natural-language text (e.g. a tool-call-only
  // message) is NOT a natural assistant message: do not surface it as a
  // completion — its tool calls surface via tool_execution events, and
  // surfacing it would emit a stray assistant.message.completed with no
  // held-latest `final` flag. Non-assistant message_end (user/toolResult)
  // passes through unchanged.
  if (piMessage?.role === 'assistant') {
    return []
  }
  const message = mapPiMessage(piMessage)
  return [
    {
      type: 'message_end',
      ...(messageId !== undefined ? { messageId } : {}),
      ...(message !== undefined ? { message } : {}),
    },
  ]
}

export function mapPiEventToUnified(
  piEvent: PiAgentSessionEvent,
  sessionId: string,
  state: PiEventMappingState = createPiEventMappingState()
): UnifiedSessionEvent[] {
  switch (piEvent.type) {
    case PI_EVENT.AGENT_START:
      state.agentActive = true
      state.held = undefined
      return [{ type: 'agent_start', sessionId }]
    case PI_EVENT.AGENT_END:
      return handleAgentEnd(piEvent, sessionId, state)
    case PI_EVENT.TURN_START: {
      const turnId = typeof piEvent.turnId === 'string' ? piEvent.turnId : undefined
      return [
        {
          type: 'turn_start',
          ...(turnId !== undefined ? { turnId } : {}),
        },
      ]
    }
    case PI_EVENT.TURN_END:
      return handleTurnEnd(piEvent, state)
    case PI_EVENT.MESSAGE_START: {
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
    case PI_EVENT.MESSAGE_UPDATE: {
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
        }
      }

      return [event as UnifiedSessionEvent]
    }
    case PI_EVENT.MESSAGE_END:
      return handleMessageEnd(piEvent, state)
    case PI_EVENT.TOOL_EXECUTION_START:
      return [
        {
          type: 'tool_execution_start',
          toolUseId: piEvent.toolCallId ?? '',
          toolName: piEvent.toolName ?? '',
          input: normalizeToolInput(piEvent.args),
        },
      ]
    case PI_EVENT.TOOL_EXECUTION_UPDATE:
      return [
        {
          type: 'tool_execution_update',
          toolUseId: piEvent.toolCallId ?? '',
          ...(piEvent.partialResult !== undefined
            ? { partialOutput: String(piEvent.partialResult) }
            : {}),
        },
      ]
    case PI_EVENT.TOOL_EXECUTION_END:
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

interface RawContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  url?: string
  filename?: string
  alt?: string
}

function isRawContentBlock(item: unknown): item is RawContentBlock {
  return typeof item === 'object' && item !== null && 'type' in item
}

/**
 * Map a single tool-result content item (of unknown shape) to a ContentBlock.
 * Recognizes image / media_ref / text blocks; an already-shaped block falls
 * through verbatim, and a scalar item is stringified into a text block.
 */
function mapToolResultItem(item: unknown): ContentBlock {
  if (isRawContentBlock(item)) {
    const block = item
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
}

function mapToolResultContent(result: unknown): ToolResult {
  let content: ContentBlock[]
  if (typeof result === 'string') {
    content = [{ type: 'text', text: result }]
  } else if (Array.isArray(result)) {
    content = result.map(mapToolResultItem)
  } else if (typeof result === 'object' && result !== null) {
    const objContent = (result as { content?: unknown }).content
    if (Array.isArray(objContent)) {
      content = objContent.map((item: unknown) =>
        isRawContentBlock(item) ? mapToolResultItem(item) : (item as ContentBlock)
      )
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
