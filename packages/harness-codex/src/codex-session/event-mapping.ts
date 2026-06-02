/**
 * Shared Codex app-server event mapping.
 *
 * Both the long-lived `CodexSession` and the headless `runCodexAppServerOneShot`
 * consume the same codex app-server JSON-RPC protocol. This module owns the
 * single source of truth for the `CodexThreadItem` union, the notification-param
 * interfaces, and the pure functions that map thread items to unified session
 * events. Each entry point keeps only its own lifecycle/turn-completion glue.
 */
import type { ToolResult, UnifiedSessionEvent } from 'spaces-runtime'

export type CodexThreadItem =
  | {
      type: 'agentMessage'
      id: string
      text: string
    }
  | {
      type: 'commandExecution'
      id: string
      command: string
      cwd: string
      aggregatedOutput: string | null
      exitCode: number | null
      durationMs: number | null
      status?: string | undefined
    }
  | {
      type: 'fileChange'
      id: string
      changes: Array<unknown>
      status?: string | undefined
    }
  | {
      type: 'mcpToolCall'
      id: string
      server: string
      tool: string
      arguments: unknown
      result: unknown | null
      error: unknown | null
      durationMs: number | null
      status?: string | undefined
    }
  | {
      type: 'webSearch'
      id: string
      query: string
    }
  | {
      type: 'imageView'
      id: string
      path: string
    }
  | {
      type: string
      id?: string | undefined
    }

export interface ThreadStartResponse {
  thread?: { id?: string | undefined } | undefined
}

export interface ThreadResumeResponse {
  thread?: { id?: string | undefined } | undefined
}

export interface TurnStartResponse {
  turn?: { id?: string | undefined } | undefined
}

export interface TurnStartedNotification {
  turn: { id: string }
}

export interface ItemStartedNotification {
  item: CodexThreadItem
  turnId: string
}

export interface ItemCompletedNotification {
  item: CodexThreadItem
  turnId: string
}

export interface AgentMessageDeltaNotification {
  itemId: string
  delta: string
}

export interface CommandExecutionOutputDeltaNotification {
  itemId: string
  delta: string
}

export interface FileChangeOutputDeltaNotification {
  itemId: string
  delta: string
}

export interface McpToolCallProgressNotification {
  itemId: string
  message: string
}

export interface ErrorNotification {
  error: {
    message?: string | undefined
    codexErrorInfo?: unknown
    additionalDetails?: string | null
  }
  willRetry?: boolean | undefined
  threadId?: string | undefined
  turnId?: string | undefined
}

export function buildToolResult(content: string, details?: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: content }],
    ...(details ? { details } : {}),
  }
}

/**
 * Map an `item/started` thread item to the unified events both paths emit.
 * Returns an empty array for item kinds neither path renders.
 */
export function mapItemStarted(item: CodexThreadItem): UnifiedSessionEvent[] {
  switch (item.type) {
    case 'agentMessage': {
      const agentItem = item as Extract<CodexThreadItem, { type: 'agentMessage' }>
      return [
        {
          type: 'message_start',
          messageId: agentItem.id,
          message: { role: 'assistant', content: agentItem.text ?? '' },
          payload: agentItem,
        },
      ]
    }
    case 'commandExecution': {
      const cmdItem = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
      return [
        {
          type: 'tool_execution_start',
          toolUseId: cmdItem.id,
          toolName: 'command_execution',
          input: { command: cmdItem.command, cwd: cmdItem.cwd },
          payload: cmdItem,
        },
      ]
    }
    case 'fileChange': {
      const fileItem = item as Extract<CodexThreadItem, { type: 'fileChange' }>
      return [
        {
          type: 'tool_execution_start',
          toolUseId: fileItem.id,
          toolName: 'file_change',
          input: { changes: fileItem.changes },
          payload: fileItem,
        },
      ]
    }
    case 'mcpToolCall': {
      const mcpItem = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
      return [
        {
          type: 'tool_execution_start',
          toolUseId: mcpItem.id,
          toolName: `mcp:${mcpItem.server}/${mcpItem.tool}`,
          input: { server: mcpItem.server, tool: mcpItem.tool, arguments: mcpItem.arguments },
          payload: mcpItem,
        },
      ]
    }
    case 'webSearch': {
      const searchItem = item as Extract<CodexThreadItem, { type: 'webSearch' }>
      return [
        {
          type: 'tool_execution_start',
          toolUseId: searchItem.id,
          toolName: 'web_search',
          input: { query: searchItem.query },
          payload: searchItem,
        },
      ]
    }
    case 'imageView': {
      const imageItem = item as Extract<CodexThreadItem, { type: 'imageView' }>
      return [
        {
          type: 'tool_execution_start',
          toolUseId: imageItem.id,
          toolName: 'image_view',
          input: { path: imageItem.path },
          payload: imageItem,
        },
      ]
    }
    default:
      return []
  }
}

/**
 * Map an `item/completed` thread item to the unified events both paths emit.
 * `finalOutput` is the assistant text for an `agentMessage`, which the one-shot
 * path accumulates as the turn's final output (the session path ignores it).
 */
export function mapItemCompleted(item: CodexThreadItem): {
  events: UnifiedSessionEvent[]
  finalOutput?: string | undefined
} {
  switch (item.type) {
    case 'agentMessage': {
      const agentItem = item as Extract<CodexThreadItem, { type: 'agentMessage' }>
      const text = agentItem.text ?? ''
      return {
        events: [
          {
            type: 'message_end',
            messageId: agentItem.id,
            message: { role: 'assistant', content: text },
            payload: agentItem,
          },
        ],
        finalOutput: text,
      }
    }
    case 'commandExecution': {
      const cmdItem = item as Extract<CodexThreadItem, { type: 'commandExecution' }>
      const result = buildToolResult(cmdItem.aggregatedOutput ?? '', {
        exitCode: cmdItem.exitCode,
        durationMs: cmdItem.durationMs,
      })
      return {
        events: [
          {
            type: 'tool_execution_end',
            toolUseId: cmdItem.id,
            toolName: 'command_execution',
            result,
            ...(cmdItem.exitCode !== null && cmdItem.exitCode !== 0 ? { isError: true } : {}),
            ...(cmdItem.durationMs !== null ? { durationMs: cmdItem.durationMs } : {}),
            payload: cmdItem,
          },
        ],
      }
    }
    case 'fileChange': {
      const fileItem = item as Extract<CodexThreadItem, { type: 'fileChange' }>
      return {
        events: [
          {
            type: 'tool_execution_end',
            toolUseId: fileItem.id,
            toolName: 'file_change',
            result: buildToolResult(JSON.stringify(fileItem.changes ?? [], null, 2)),
            ...(fileItem.status && fileItem.status !== 'completed' ? { isError: true } : {}),
            payload: fileItem,
          },
        ],
      }
    }
    case 'mcpToolCall': {
      const mcpItem = item as Extract<CodexThreadItem, { type: 'mcpToolCall' }>
      const resultPayload = mcpItem.error ?? mcpItem.result ?? ''
      return {
        events: [
          {
            type: 'tool_execution_end',
            toolUseId: mcpItem.id,
            toolName: `mcp:${mcpItem.server}/${mcpItem.tool}`,
            result: buildToolResult(
              typeof resultPayload === 'string'
                ? resultPayload
                : JSON.stringify(resultPayload, null, 2)
            ),
            ...(mcpItem.error ? { isError: true } : {}),
            ...(mcpItem.durationMs !== null ? { durationMs: mcpItem.durationMs } : {}),
            payload: mcpItem,
          },
        ],
      }
    }
    case 'webSearch': {
      const searchItem = item as Extract<CodexThreadItem, { type: 'webSearch' }>
      return {
        events: [
          {
            type: 'tool_execution_end',
            toolUseId: searchItem.id,
            toolName: 'web_search',
            result: buildToolResult(`web_search: ${searchItem.query}`),
            payload: searchItem,
          },
        ],
      }
    }
    case 'imageView': {
      const imageItem = item as Extract<CodexThreadItem, { type: 'imageView' }>
      return {
        events: [
          {
            type: 'tool_execution_end',
            toolUseId: imageItem.id,
            toolName: 'image_view',
            result: buildToolResult(`image_view: ${imageItem.path}`),
            payload: imageItem,
          },
        ],
      }
    }
    default:
      return { events: [] }
  }
}
