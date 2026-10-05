/** Codex tool items (`commandExecution`, `mcpToolCall`, …) → broker tool-call events. */
import { codexNativeToolIdentity } from '../codex-tool-identity'
import type { MappedEvent, MappedEventFor } from './event-map'
import {
  asRecord,
  asToolCallId,
  asTurnId,
  numberValue,
  objectWithDefined,
  stringValue,
} from './native-params'

const TOOL_NAMES: Record<string, string> = {
  commandExecution: 'command',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool',
  webSearch: 'web_search',
  imageView: 'image_view',
  imageGeneration: 'image_generation',
}

export const TOOL_TYPES = new Set(Object.keys(TOOL_NAMES))

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
    case 'imageGeneration':
      // `revisedPrompt` is null until the item completes; a started image
      // generation legitimately has no input to report.
      return (
        objectWithDefined({ prompt: clipImagePrompt(stringValue(item['revisedPrompt'])) }) ??
        explicitInput
      )
    default:
      return undefined
  }
}

export function mapToolItemStarted(
  itemType: string,
  item: Record<string, unknown>,
  turnId: string,
  itemId: string
): MappedEventFor<'tool.call.started'> {
  const identity = codexNativeToolIdentity(
    itemType,
    item,
    itemType === 'commandExecution' ? itemType : (TOOL_NAMES[itemType] ?? itemType)
  ) ?? {
    itemId,
    toolCallId: asToolCallId(itemId),
    name: TOOL_NAMES[itemType] ?? itemType,
  }
  const input = normalizeToolInput(itemType, item)
  return {
    type: 'tool.call.started',
    payload: {
      toolCallId: identity.toolCallId,
      name: identity.name,
      ...(input !== undefined ? { input } : {}),
    },
    extra: { turnId: asTurnId(turnId), itemId: identity.itemId },
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
    case 'imageGeneration': {
      // `result` is the RAW BASE64 IMAGE (~1.4MB observed). It must never reach
      // the durable event stream or the pane, so this case NEVER falls back to
      // `explicitResult`: report the on-disk artifact and the encoded size only.
      const encoded = stringValue(item['result'])
      const failure = item['failure']
      return objectWithDefined({
        savedPath: stringValue(item['savedPath']),
        prompt: clipImagePrompt(stringValue(item['revisedPrompt'])),
        encodedBytes: encoded !== undefined && encoded.length > 0 ? encoded.length : undefined,
        ...(failure !== undefined && failure !== null ? { failure } : {}),
      })
    }
    case 'imageView': {
      const path = stringValue(item['path'])
      return path !== undefined ? { path } : explicitResult
    }
    default:
      return undefined
  }
}

/** Bound the provider's revised image prompt; observed values run to ~2KB. */
const MAX_IMAGE_PROMPT_CHARS = 500

function clipImagePrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined || prompt.length === 0) return undefined
  return prompt.length > MAX_IMAGE_PROMPT_CHARS
    ? `${prompt.slice(0, MAX_IMAGE_PROMPT_CHARS)}…`
    : prompt
}

/**
 * A completed Codex tool call reached its terminal RESULT BOUNDARY; a failed one
 * terminated WITHOUT a result. The `failed` variant carries the contract fields
 * (machine-readable `code`, human `message`) so the emission never has to
 * reconstruct them.
 */
type ToolOutcome = { kind: 'completed' } | { kind: 'failed'; code: string; message: string }

/**
 * Map a completed Codex tool `item/completed` to its single terminal event
 * (T-06550). A call that reached its result boundary is `tool.call.completed` —
 * a nonzero process exit STAYS completed (exitCode carried at the neutral
 * `result.exitCode`, never aliased to `failed` nor derived into `isError`). A
 * call that terminated WITHOUT a result boundary is `tool.call.failed`, emitting
 * the contract ToolCallFailedPayload (required `message`, always-populated
 * machine-readable `code`) — never the completed shape.
 */
export function mapToolItemCompleted(
  itemType: string,
  item: Record<string, unknown>,
  itemId: string,
  turnId: string
): MappedEvent {
  const result = normalizeToolResult(itemType, item)
  const durationMs = numberValue(item['durationMs'])
  const identity = codexNativeToolIdentity(
    itemType,
    item,
    stringValue(item['name']) ??
      (itemType === 'commandExecution' ? itemType : (TOOL_NAMES[itemType] ?? itemType))
  ) ?? {
    itemId,
    toolCallId: asToolCallId(itemId),
    name: stringValue(item['name']) ?? TOOL_NAMES[itemType] ?? itemType,
  }
  const name = identity.name
  const extra = { turnId: asTurnId(turnId), itemId: identity.itemId }
  const outcome = classifyToolOutcome(itemType, item)

  if (outcome.kind === 'failed') {
    const data = objectWithDefined({ result, durationMs })
    return {
      type: 'tool.call.failed',
      payload: {
        toolCallId: identity.toolCallId,
        name,
        message: outcome.message,
        code: outcome.code,
        ...(data !== undefined ? { data } : {}),
      },
      extra,
    }
  }

  return {
    type: 'tool.call.completed',
    payload: {
      toolCallId: identity.toolCallId,
      name,
      ...(result !== undefined ? { result } : {}),
      // isError reports a DOMAIN error signal only. Codex surfaces none on a
      // completed item (the mcpToolCall error channel is a FAILED path; a
      // process exitCode is not a domain error), so a completed Codex tool call
      // is always isError:false.
      isError: false,
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    extra,
  }
}

/**
 * Classify a Codex `item/completed` tool item into a terminal outcome
 * (T-06550, daedalus-ruled 2026-07-18). Rulings, recorded against real payload
 * evidence in the task's evidence comment:
 *
 * - Scope 2(a) PRECEDENCE (status vs exitCode): the upstream schema makes the
 *   commandExecution `status` a required enum that INCLUDES `failed`, but the
 *   repo has no real capture proving whether Codex sets `status:'failed'` for an
 *   ordinary nonzero exit vs only for a spawn/handler failure. The ambiguity is
 *   itself the evidence: acceptance 1 wins, so a commandExecution that carries a
 *   DEFINED `exitCode` has reached its result boundary → `completed`, REGARDLESS
 *   of status. `status !== 'completed'` maps to `failed` only when NO exitCode is
 *   present (never-ran / spawn failure / a `declined` pre-execution rejection).
 * - Scope 2(b) (mcpToolCall `error`): CONFIRMED the transport/execution error
 *   channel — `McpToolCallError` is `{ message }`, the `Err(String)` side of the
 *   upstream `Result<CallToolResult, String>`; the success `McpToolCallResult`
 *   has NO `isError`. Domain results-with-isError are structurally absent, so a
 *   non-null `error` is a transport/handler failure → `failed`.
 */
function classifyToolOutcome(itemType: string, item: Record<string, unknown>): ToolOutcome {
  // Result-boundary guard (scope 2a precedence): a defined exitCode means the
  // command ran to a result — a nonzero exit is a completed result, never
  // re-aliased to failed even if the provider also stamped a non-'completed'
  // status. This is the scope-1 regression tripwire.
  if (itemType === 'commandExecution' && numberValue(item['exitCode']) !== undefined) {
    return { kind: 'completed' }
  }

  // No result boundary + provider reports a non-'completed' terminal status →
  // failed, code derived from the status (e.g. `codex_failed`, `codex_declined`).
  const status = stringValue(item['status'])
  if (status !== undefined && status !== 'completed') {
    return {
      kind: 'failed',
      code: `codex_${status}`,
      message: `Codex reported the ${TOOL_NAMES[itemType] ?? itemType} tool as "${status}" without returning a result`,
    }
  }

  // mcpToolCall transport/execution error channel → failed.
  if (itemType === 'mcpToolCall') {
    const error = item['error']
    if (error !== undefined && error !== null) {
      return {
        kind: 'failed',
        code: 'codex_mcp_error',
        message: mcpErrorMessage(error),
      }
    }
  }

  return { kind: 'completed' }
}

/** Human message for a failed mcpToolCall from its `McpToolCallError` (`{ message }`) or a raw string. */
function mcpErrorMessage(error: unknown): string {
  if (typeof error === 'string' && error.length > 0) return error
  const message = stringValue(asRecord(error)['message'])
  return message !== undefined && message.length > 0 ? message : 'MCP tool call failed'
}
