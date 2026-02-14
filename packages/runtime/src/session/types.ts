import type { PermissionHandler } from './permissions.js'

export type SessionKind = 'agent-sdk' | 'pi' | 'codex'

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'media_ref'; url: string; mimeType?: string; filename?: string; alt?: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface Message {
  role: 'user' | 'assistant' | 'toolResult'
  content: ContentBlock[] | string
}

export interface ToolResult {
  content: ContentBlock[]
  details?: Record<string, unknown>
}

export interface AgentStartEvent {
  type: 'agent_start'
  sessionId?: string
  sdkSessionId?: string
}

export interface AgentEndEvent {
  type: 'agent_end'
  sessionId?: string
  sdkSessionId?: string
  reason?: string
}

export interface TurnStartEvent {
  type: 'turn_start'
  turnId?: string
}

export interface TurnEndEvent {
  type: 'turn_end'
  turnId?: string
  toolResults?: Array<{
    toolUseId: string
    result: ToolResult
  }>
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface MessageStartEvent {
  type: 'message_start'
  messageId?: string
  message: Message
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface MessageUpdateEvent {
  type: 'message_update'
  messageId?: string
  textDelta?: string
  contentBlocks?: ContentBlock[]
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface MessageEndEvent {
  type: 'message_end'
  messageId?: string
  message?: Message
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface ToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  /** ID of the parent Task tool if this is from a subagent */
  parentToolUseId?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolUseId: string
  message?: string
  partialOutput?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

export interface ToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolUseId: string
  toolName: string
  result: ToolResult
  isError?: boolean
  durationMs?: number
  /** ID of the parent Task tool if this is from a subagent */
  parentToolUseId?: string
  /** Raw payload from harness for downstream clients */
  payload?: unknown
}

/** Event emitted when SDK provides its internal session ID (for resume) */
export interface SdkSessionIdEvent {
  type: 'sdk_session_id'
  sdkSessionId: string
}

export type UnifiedSessionEvent =
  | AgentStartEvent
  | AgentEndEvent
  | TurnStartEvent
  | TurnEndEvent
  | MessageStartEvent
  | MessageUpdateEvent
  | MessageEndEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | SdkSessionIdEvent

export type UnifiedSessionState = 'idle' | 'running' | 'streaming' | 'stopped' | 'error'

export interface AttachmentRef {
  kind: 'url' | 'file'
  filename?: string
  url?: string
  path?: string
}

export interface PromptOptions {
  attachments?: AttachmentRef[]
  runId?: string
  metadata?: Record<string, unknown>
}

export interface UnifiedSession {
  readonly sessionId: string
  readonly kind: SessionKind
  start(): Promise<void>
  stop(reason?: string): Promise<void>
  /**
   * Interrupt the currently active turn without shutting down the full session.
   * Implementations may omit this when unsupported.
   */
  interrupt?(reason?: string): Promise<void>
  isHealthy(): boolean
  getState(): UnifiedSessionState
  sendPrompt(text: string, options?: PromptOptions): Promise<void>
  onEvent(callback: (event: UnifiedSessionEvent) => void): void
  setPermissionHandler(handler: PermissionHandler): void
}
