import type { InvocationEventType } from 'spaces-harness-broker-protocol'
import type { JsonRpcNotification } from './rpc-client'

export interface MappedEvent {
  type: InvocationEventType
  payload: unknown
  extra?: {
    turnId?: string | undefined
    inputId?: string | undefined
    itemId?: string | undefined
    driver?: { kind: string; rawType?: string | undefined } | undefined
  }
}

export interface CodexErrorInfo {
  message: string
  code?: string | undefined
  data?: unknown
}

const TOOL_NAMES: Record<string, string> = {
  commandExecution: 'command',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool',
  webSearch: 'web_search',
  imageView: 'image_view',
}

const TOOL_TYPES = new Set(Object.keys(TOOL_NAMES))

export function mapCodexNotification(notification: JsonRpcNotification): MappedEvent[] {
  const params = asRecord(notification.params)

  switch (notification.method) {
    case 'turn/started': {
      const turnId = stringValue(params['turnId']) ?? stringValue(asRecord(params['turn'])['id'])
      if (!turnId) return []
      return [
        {
          type: 'turn.started',
          payload: { turnId },
          extra: { turnId },
        },
      ]
    }

    case 'thread/tokenUsage/updated': {
      const usage = params['usage'] ?? params['tokenUsage'] ?? params['token_usage']
      return [{ type: 'usage.updated', payload: { usage } }]
    }

    case 'item/started': {
      const turnId = stringValue(params['turnId'])
      const item = asRecord(params['item'])
      const itemType = stringValue(item['type'])
      const itemId = stringValue(item['id'])
      if (!turnId || !itemType || !itemId) return []

      if (itemType === 'agentMessage') {
        return [
          {
            type: 'assistant.message.started',
            payload: { messageId: itemId },
            extra: { turnId, itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        const input = normalizeToolInput(itemType, item)
        return [
          {
            type: 'tool.call.started',
            payload: {
              toolCallId: itemId,
              name: TOOL_NAMES[itemType] ?? itemType,
              ...(input !== undefined ? { input } : {}),
            },
            extra: { turnId, itemId },
          },
        ]
      }
      return []
    }

    case 'item/agentMessage/delta': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      const text = stringValue(params['text']) ?? stringValue(params['delta'])
      if (!turnId || !itemId || text === undefined) return []
      return [
        {
          type: 'assistant.message.delta',
          payload: { messageId: itemId, text },
          extra: { turnId, itemId },
        },
      ]
    }

    case 'item/commandExecution/outputDelta':
    case 'item/fileChange/outputDelta': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      const text = stringValue(params['text']) ?? stringValue(params['delta'])
      if (!turnId || !itemId || text === undefined) return []
      return [
        {
          type: 'tool.call.delta',
          payload: { toolCallId: itemId, text },
          extra: { turnId, itemId },
        },
      ]
    }

    case 'item/mcpToolCall/progress': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      if (!turnId || !itemId) return []
      return [
        {
          type: 'tool.call.delta',
          payload: {
            toolCallId: itemId,
            ...(params['data'] !== undefined ? { data: params['data'] } : { data: params }),
          },
          extra: { turnId, itemId },
        },
      ]
    }

    case 'item/completed': {
      const turnId = stringValue(params['turnId'])
      const item = asRecord(params['item'])
      const itemType = stringValue(item['type'])
      const itemId = stringValue(item['id'])
      if (!turnId || !itemType || !itemId) return []

      if (itemType === 'agentMessage') {
        return [
          {
            type: 'assistant.message.completed',
            payload: {
              messageId: itemId,
              content: normalizeMessageContent(item),
              final: true,
            },
            extra: { turnId, itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        const result = normalizeToolResult(itemType, item)
        const durationMs = numberValue(item['durationMs'])
        const isError = isToolError(itemType, item)
        return [
          {
            type: isError ? 'tool.call.failed' : 'tool.call.completed',
            payload: {
              toolCallId: itemId,
              name: stringValue(item['name']) ?? TOOL_NAMES[itemType] ?? itemType,
              ...(result !== undefined ? { result } : {}),
              isError,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
            extra: { turnId, itemId },
          },
        ]
      }

      return []
    }

    case 'turn/completed': {
      const turn = asRecord(params['turn'])
      const turnId = stringValue(params['turnId']) ?? stringValue(turn['id'])
      if (!turnId) return []
      const rawStatus = stringValue(params['status']) ?? stringValue(turn['status'])
      const status =
        rawStatus === 'failed'
          ? 'failed'
          : rawStatus === 'interrupted'
            ? 'interrupted'
            : 'completed'
      return [
        {
          type:
            status === 'failed'
              ? 'turn.failed'
              : status === 'interrupted'
                ? 'turn.interrupted'
                : 'turn.completed',
          payload: {
            turnId,
            status,
            ...(params['finalOutput'] !== undefined
              ? { finalOutput: params['finalOutput'] }
              : turn['finalOutput'] !== undefined
                ? { finalOutput: turn['finalOutput'] }
                : {}),
          },
          extra: { turnId },
        },
      ]
    }

    default:
      return []
  }
}

export function parseCodexError(params: unknown): CodexErrorInfo {
  const root = asRecord(params)
  const nested = asRecord(root['error'])
  const message =
    stringValue(root['message']) ?? stringValue(nested['message']) ?? 'Codex app-server error'
  const code =
    stringValue(root['code']) ??
    stringValue(nested['code']) ??
    stringValue(asRecord(nested['codexErrorInfo'])['code'])
  const data = Object.keys(root).length > 0 ? root : undefined
  return {
    message,
    ...(code !== undefined ? { code } : {}),
    ...(data !== undefined ? { data } : {}),
  }
}

function normalizeMessageContent(
  item: Record<string, unknown>
): Array<{ type: 'text'; text: string }> {
  const content = item['content']
  if (Array.isArray(content)) {
    return content.flatMap((part) => {
      const record = asRecord(part)
      const text = stringValue(record['text'])
      return record['type'] === 'text' && text !== undefined
        ? [{ type: 'text' as const, text }]
        : []
    })
  }

  const text = stringValue(item['text']) ?? ''
  return [{ type: 'text', text }]
}

function normalizeToolInput(itemType: string, item: Record<string, unknown>): unknown {
  const explicitInput = item['input']

  switch (itemType) {
    case 'commandExecution':
      return (
        objectWithDefined({
          command: stringValue(item['command']),
          cwd: stringValue(item['cwd']),
        }) ?? explicitInput
      )
    case 'fileChange':
      return item['changes'] !== undefined ? { changes: item['changes'] } : explicitInput
    case 'mcpToolCall':
      return (
        objectWithDefined({
          server: stringValue(item['server']),
          tool: stringValue(item['tool']),
          arguments: item['arguments'],
        }) ?? explicitInput
      )
    case 'webSearch':
      return objectWithDefined({ query: stringValue(item['query']) }) ?? explicitInput
    case 'imageView':
      return objectWithDefined({ path: stringValue(item['path']) }) ?? explicitInput
    default:
      return undefined
  }
}

function normalizeToolResult(itemType: string, item: Record<string, unknown>): unknown {
  const explicitResult = item['result']

  switch (itemType) {
    case 'commandExecution':
      return (
        objectWithDefined({
          output: stringValue(item['aggregatedOutput']),
          exitCode: numberValue(item['exitCode']),
        }) ?? explicitResult
      )
    case 'fileChange':
      return item['changes'] !== undefined ? { changes: item['changes'] } : explicitResult
    case 'mcpToolCall': {
      const error = item['error']
      if (error !== undefined && error !== null) {
        return {
          error,
          ...(explicitResult !== null && explicitResult !== undefined
            ? { result: explicitResult }
            : {}),
        }
      }
      return explicitResult !== null && explicitResult !== undefined ? explicitResult : undefined
    }
    case 'webSearch': {
      const query = stringValue(item['query'])
      return query !== undefined ? { query } : explicitResult
    }
    case 'imageView': {
      const path = stringValue(item['path'])
      return path !== undefined ? { path } : explicitResult
    }
    default:
      return undefined
  }
}

function isToolError(itemType: string, item: Record<string, unknown>): boolean {
  const status = stringValue(item['status'])
  if (status !== undefined && status !== 'completed') return true

  switch (itemType) {
    case 'commandExecution': {
      const exitCode = numberValue(item['exitCode'])
      return exitCode !== undefined && exitCode !== 0
    }
    case 'mcpToolCall': {
      const error = item['error']
      return error !== undefined && error !== null
    }
    case 'fileChange':
    case 'webSearch':
    case 'imageView':
      return false
    default:
      return false
  }
}

function objectWithDefined(values: Record<string, unknown>): Record<string, unknown> | undefined {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) {
      result[key] = value
    }
  }
  return Object.keys(result).length > 0 ? result : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined
}
