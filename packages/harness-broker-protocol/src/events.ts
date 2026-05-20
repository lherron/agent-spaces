export interface InvocationEventEnvelope<TPayload = unknown> {
  invocationId: string
  seq: number
  time: string
  type: InvocationEventType
  payload: TPayload
  turnId?: string | undefined
  inputId?: string | undefined
  itemId?: string | undefined
  correlation?: Record<string, string> | undefined
  driver?:
    | {
        kind: string
        rawType?: string | undefined
      }
    | undefined
}

export type InvocationEventType =
  | 'invocation.started'
  | 'invocation.ready'
  | 'invocation.stopping'
  | 'invocation.exited'
  | 'invocation.failed'
  | 'invocation.disposed'
  | 'continuation.updated'
  | 'input.accepted'
  | 'input.rejected'
  | 'input.queued'
  | 'turn.started'
  | 'turn.completed'
  | 'turn.failed'
  | 'turn.interrupted'
  | 'assistant.message.started'
  | 'assistant.message.delta'
  | 'assistant.message.completed'
  | 'tool.call.started'
  | 'tool.call.delta'
  | 'tool.call.completed'
  | 'tool.call.failed'
  | 'usage.updated'
  | 'diagnostic'
  | 'driver.notice'

export interface InvocationStartedPayload {
  pid?: number | undefined
  command: string
  args: string[]
  cwd: string
}

export interface ContinuationUpdate {
  provider: string
  key: string
  kind?: string | undefined
}

export interface TurnStartedPayload {
  turnId: string
}

export interface AssistantMessageStartedPayload {
  messageId: string
}

export interface AssistantMessageDeltaPayload {
  messageId: string
  text: string
}

export interface AssistantMessageCompletedPayload {
  messageId: string
  content: Array<{ type: 'text'; text: string }>
  final?: boolean | undefined
}

export interface ToolCallStartedPayload {
  toolCallId: string
  name: string
  input?: unknown
}

export interface ToolCallDeltaPayload {
  toolCallId: string
  text?: string | undefined
  data?: unknown
}

export interface ToolCallCompletedPayload {
  toolCallId: string
  name: string
  result?: unknown
  isError?: boolean | undefined
  durationMs?: number | undefined
}

export interface TurnCompletedPayload {
  turnId: string
  status: 'completed' | 'failed' | 'interrupted'
  finalOutput?: string | undefined
  usage?: unknown
}

export interface DiagnosticPayload {
  level: 'debug' | 'info' | 'warn' | 'error'
  message: string
  source?: 'broker' | 'harness' | 'driver' | undefined
  data?: unknown
}

export interface InvocationExitedPayload {
  exitCode?: number | null | undefined
  signal?: string | null | undefined
}

export interface InvocationFailedPayload {
  message: string
  code?: string | undefined
  data?: unknown
}

export interface InputDispositionPayload {
  inputId: string
  reason?: string | undefined
}

export interface UsageUpdatedPayload {
  usage: unknown
}

export interface DriverNoticePayload {
  message: string
  code?: string | undefined
  data?: unknown
}
