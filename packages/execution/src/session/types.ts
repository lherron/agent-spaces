import type { PermissionHandler } from './permissions.js'

export type SessionKind = 'agent-sdk' | 'pi'

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
}

export interface MessageStartEvent {
  type: 'message_start'
  messageId?: string
  message: Message
}

export interface MessageUpdateEvent {
  type: 'message_update'
  messageId?: string
  textDelta?: string
  contentBlocks?: ContentBlock[]
}

export interface MessageEndEvent {
  type: 'message_end'
  messageId?: string
  message?: Message
}

export interface ToolExecutionStartEvent {
  type: 'tool_execution_start'
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
}

export interface ToolExecutionUpdateEvent {
  type: 'tool_execution_update'
  toolUseId: string
  message?: string
  partialOutput?: string
}

export interface ToolExecutionEndEvent {
  type: 'tool_execution_end'
  toolUseId: string
  toolName: string
  result: ToolResult
  isError?: boolean
  durationMs?: number
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
  isHealthy(): boolean
  getState(): UnifiedSessionState
  sendPrompt(text: string, options?: PromptOptions): Promise<void>
  onEvent(callback: (event: UnifiedSessionEvent) => void): void
  setPermissionHandler(handler: PermissionHandler): void
}
