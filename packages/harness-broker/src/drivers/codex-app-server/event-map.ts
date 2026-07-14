import type { InputId, InvocationEventType, TurnId } from 'spaces-harness-broker-protocol'
import type { JsonRpcNotification } from './rpc-client'

export interface MappedEvent {
  type: InvocationEventType
  payload: unknown
  extra?: {
    turnId?: TurnId | undefined
    inputId?: InputId | undefined
    itemId?: string | undefined
    driver?: { kind: string; rawType?: string | undefined } | undefined
  }
}

export interface CodexErrorInfo {
  message: string
  code?: string | undefined
  data?: unknown
}

/** Stable driver identity stamped onto every event derived from a native notification. */
export const CODEX_DRIVER_KIND = 'codex-app-server'

const TOOL_NAMES: Record<string, string> = {
  commandExecution: 'command',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool',
  webSearch: 'web_search',
  imageView: 'image_view',
}

const TOOL_TYPES = new Set(Object.keys(TOOL_NAMES))

/**
 * Native Codex notifications that are pure state churn or account telemetry with
 * no operator value in the transcript. Dropped at the mapper so they never enter
 * the durable event stream (and thus never reach the renderer pane).
 */
const SUPPRESSED_METHODS = new Set<string>([
  'account/rateLimits/updated',
  'thread/status/changed',
  'remoteControl/status/changed',
  'mcpServer/startupStatus/updated',
])

export interface DiffFileStat {
  path: string
  added: number
  removed: number
}

export interface DiffSummary {
  files: DiffFileStat[]
  totalAdded: number
  totalRemoved: number
  /** Files beyond the per-summary cap, elided from `files`. */
  truncated: number
}

const MAX_DIFF_FILES = 8

/**
 * Reasoning summaries are durable churn-forensics evidence, not a token stream.
 * Keep one bounded summary per completed reasoning item: enough to explain the
 * model's next action without turning the broker ledger into a second rollout.
 */
const MAX_REASONING_SUMMARY_PARTS = 8
const MAX_REASONING_SUMMARY_CHARS = 4_096

/**
 * Summarize a unified diff into compact per-file add/remove counts. Only the
 * `diff --git` file boundaries and `+`/`-` body lines are counted; the `+++`/
 * `---` headers and hunk markers are excluded. The full diff body is discarded —
 * only counts survive, keeping the derived event payload small.
 */
export function summarizeUnifiedDiff(diff: string): DiffSummary {
  const files: DiffFileStat[] = []
  let current: DiffFileStat | undefined
  let totalAdded = 0
  let totalRemoved = 0
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const match = /[ ]b\/(.+)$/.exec(line)
      current = { path: match?.[1] ?? 'file', added: 0, removed: 0 }
      files.push(current)
      continue
    }
    if (current === undefined) continue
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+')) {
      current.added += 1
      totalAdded += 1
    } else if (line.startsWith('-')) {
      current.removed += 1
      totalRemoved += 1
    }
  }
  return {
    files: files.slice(0, MAX_DIFF_FILES),
    totalAdded,
    totalRemoved,
    truncated: Math.max(0, files.length - MAX_DIFF_FILES),
  }
}

type HeldAssistantCompletions = Map<string, MappedEvent>

/**
 * The last diff summary emitted per turn, so an unchanged repeat can be dropped
 * (T-06350). Keyed by turnId and cleared on `turn/started`, so each turn always
 * renders its first diff even if it happens to match the previous turn's last.
 */
type LastDiffSignatures = Map<string, string>

const defaultHeldAssistantCompletions: HeldAssistantCompletions = new Map()
const defaultLastDiffSignatures: LastDiffSignatures = new Map()

function asTurnId(value: string): TurnId {
  return value as TurnId
}

/**
 * Map a native Codex app-server notification to zero or more normalized broker
 * events. Every emitted event is stamped with `extra.driver` so consumers can
 * trace it back to the native method without that native type ever leaking into
 * the normalized `type`. Unknown native methods become a trace-level diagnostic
 * (again carrying `rawType`) rather than being silently dropped.
 */
export function mapCodexNotification(notification: JsonRpcNotification): MappedEvent[] {
  return mapCodexNotificationWithState(
    notification,
    defaultHeldAssistantCompletions,
    defaultLastDiffSignatures
  )
}

export function createCodexNotificationMapper(): (
  notification: JsonRpcNotification
) => MappedEvent[] {
  const heldAssistantCompletions: HeldAssistantCompletions = new Map()
  const lastDiffSignatures: LastDiffSignatures = new Map()
  return (notification) =>
    mapCodexNotificationWithState(notification, heldAssistantCompletions, lastDiffSignatures)
}

function mapCodexNotificationWithState(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const driver = { kind: CODEX_DRIVER_KIND, rawType: notification.method }
  return mapCodexNotificationInner(notification, heldAssistantCompletions, lastDiffSignatures).map(
    (event) => ({
      ...event,
      extra: { ...event.extra, driver: event.extra?.driver ?? driver },
    })
  )
}

/**
 * `turn/diff/updated` → a compact per-file filestat card, deduped per turn.
 *
 * Codex sends this event carrying a CUMULATIVE snapshot of the whole turn's diff
 * rather than a delta, and re-sends it unchanged on every
 * `account/rateLimits/updated` telemetry heartbeat. Measured over the largest real
 * captured transcripts: of 992 fires, the 822 that followed a heartbeat carried a
 * byte-identical diff (100%), while the 170 that followed an actual
 * `item/completed(fileChange)` carried none (0%). Mapping each fire repainted the
 * same card down the pane (T-06350).
 *
 * Dedupe on the SUMMARY rather than on which method preceded the event: it states
 * the real invariant — never emit a card that says nothing new — and it does not
 * couple us to a heartbeat-pairing detail of a provider we do not control. It also
 * correctly drops the case where the diff body moved but the rendered `+/-` stats
 * did not (an in-place edit at equal line counts), where the card would be identical.
 */
function mapDiffUpdated(
  params: Record<string, unknown>,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const diff = stringValue(params['diff'])
  if (diff === undefined || diff.trim().length === 0) return []
  const summary = summarizeUnifiedDiff(diff)
  if (summary.files.length === 0) return []
  const turnId = stringValue(params['turnId']) ?? ''
  const signature = JSON.stringify(summary)
  if (lastDiffSignatures.get(turnId) === signature) return []
  lastDiffSignatures.set(turnId, signature)
  // Only the compact per-file +/- summary is carried (never the full diff body), so
  // the payload stays small and survives event-size truncation.
  return [
    {
      type: 'diagnostic',
      payload: {
        level: 'info',
        source: 'driver',
        kind: 'diff',
        message: `diff updated (${summary.files.length} file${summary.files.length === 1 ? '' : 's'}, +${summary.totalAdded} -${summary.totalRemoved})`,
        data: summary,
      },
    },
  ]
}

function mapCodexNotificationInner(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures
): MappedEvent[] {
  const params = asRecord(notification.params)

  switch (notification.method) {
    case 'turn/started': {
      const turnId = stringValue(params['turnId']) ?? stringValue(asRecord(params['turn'])['id'])
      if (!turnId) return []
      heldAssistantCompletions.delete(turnId)
      lastDiffSignatures.delete(turnId)
      return [
        {
          type: 'turn.started',
          payload: { turnId },
          extra: { turnId: asTurnId(turnId) },
        },
      ]
    }

    case 'thread/tokenUsage/updated': {
      const usage = params['usage'] ?? params['tokenUsage'] ?? params['token_usage']
      return [{ type: 'usage.updated', payload: { usage } }]
    }

    case 'turn/plan/updated': {
      const rawPlan = params['plan']
      const steps = Array.isArray(rawPlan)
        ? rawPlan.flatMap((entry) => {
            const rec = asRecord(entry)
            const step = stringValue(rec['step'])
            return step !== undefined
              ? [{ step, status: stringValue(rec['status']) ?? 'pending' }]
              : []
          })
        : []
      if (steps.length === 0) return []
      const explanation = stringValue(params['explanation'])
      // Routed through `diagnostic` (no strict payload validator) rather than a
      // new protocol event type, so the renderer gets the structured plan without
      // a cross-repo protocol bump. `kind` discriminates it from a log line.
      return [
        {
          type: 'diagnostic',
          payload: {
            level: 'info',
            source: 'driver',
            kind: 'plan',
            message: `plan updated (${steps.length} step${steps.length === 1 ? '' : 's'})`,
            data: { steps, ...(explanation !== undefined ? { explanation } : {}) },
          },
        },
      ]
    }

    case 'turn/diff/updated':
      return mapDiffUpdated(params, lastDiffSignatures)

    // Summary deltas are aggregated by Codex into the completed reasoning item.
    // Do not emit one diagnostic per delta: that is high-volume UI/ledger spam.
    // Raw reasoning text is also intentionally excluded; only the provider's
    // user-facing reasoning summary is eligible for durable capture.
    case 'item/reasoning/summaryPartAdded':
    case 'item/reasoning/summaryTextDelta':
    case 'item/reasoning/textDelta':
      return []

    case 'item/started': {
      const turnId = stringValue(params['turnId'])
      const item = asRecord(params['item'])
      const itemType = stringValue(item['type'])
      const itemId = stringValue(item['id'])
      if (!turnId || !itemType || !itemId) return []

      if (itemType === 'agentMessage') {
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          {
            type: 'assistant.message.started',
            payload: { messageId: itemId },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        const input = normalizeToolInput(itemType, item)
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          {
            type: 'tool.call.started',
            payload: {
              toolCallId: itemId,
              name: TOOL_NAMES[itemType] ?? itemType,
              ...(input !== undefined ? { input } : {}),
            },
            extra: { turnId: asTurnId(turnId), itemId },
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
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'assistant.message.delta',
          payload: { messageId: itemId, text },
          extra: { turnId: asTurnId(turnId), itemId },
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
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'tool.call.delta',
          payload: { toolCallId: itemId, text },
          extra: { turnId: asTurnId(turnId), itemId },
        },
      ]
    }

    case 'item/mcpToolCall/progress': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      if (!turnId || !itemId) return []
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'tool.call.delta',
          payload: {
            toolCallId: itemId,
            ...(params['data'] !== undefined ? { data: params['data'] } : { data: params }),
          },
          extra: { turnId: asTurnId(turnId), itemId },
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
        const previous = flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false)
        heldAssistantCompletions.set(
          turnId,
          assistantCompletionEvent(turnId, itemId, normalizeMessageContent(item), true)
        )
        return previous
      }

      if (itemType === 'reasoning') {
        const summary = normalizeReasoningSummary(item)
        if (summary === undefined) return []
        return [
          {
            type: 'diagnostic',
            payload: {
              level: 'debug',
              source: 'driver',
              kind: 'reasoning',
              message: 'Codex reasoning summary captured',
              data: summary,
            },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        const result = normalizeToolResult(itemType, item)
        const durationMs = numberValue(item['durationMs'])
        const isError = isToolError(itemType, item)
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          {
            type: isError ? 'tool.call.failed' : 'tool.call.completed',
            payload: {
              toolCallId: itemId,
              name: stringValue(item['name']) ?? TOOL_NAMES[itemType] ?? itemType,
              ...(result !== undefined ? { result } : {}),
              isError,
              ...(durationMs !== undefined ? { durationMs } : {}),
            },
            extra: { turnId: asTurnId(turnId), itemId },
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
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, true),
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
          extra: { turnId: asTurnId(turnId) },
        },
      ]
    }

    default:
      // Known high-frequency state-churn / telemetry methods carry no operator
      // value in the transcript. Explicitly classified as non-events (NOT the
      // same as silently dropping an unrecognized method) so the pane is not
      // flooded with rate-limit / thread-status / remote-control churn.
      if (SUPPRESSED_METHODS.has(notification.method)) return []
      // Any other unknown native notification: surface as a trace-level
      // diagnostic so it is observable but never leaks the native method name as
      // a normalized event `type`. The native method is preserved in
      // `extra.driver.rawType`; the renderer folds debug-level diagnostics away.
      return [
        {
          type: 'diagnostic',
          payload: {
            level: 'debug',
            message: `Unhandled Codex notification: ${notification.method}`,
            source: 'driver',
          },
        },
      ]
  }
}

function assistantCompletionEvent(
  turnId: string,
  itemId: string,
  content: Array<{ type: 'text'; text: string }>,
  final: boolean
): MappedEvent {
  return {
    type: 'assistant.message.completed',
    payload: {
      messageId: itemId,
      content,
      final,
    },
    extra: {
      turnId: asTurnId(turnId),
      itemId,
      driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
    },
  }
}

function flushHeldAssistantCompletion(
  heldAssistantCompletions: HeldAssistantCompletions,
  turnId: string,
  final: boolean
): MappedEvent[] {
  const held = heldAssistantCompletions.get(turnId)
  if (held === undefined) return []
  heldAssistantCompletions.delete(turnId)
  return [
    {
      ...held,
      payload: { ...(asRecord(held.payload) as Record<string, unknown>), final },
    },
  ]
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

function normalizeReasoningSummary(
  item: Record<string, unknown>
): { summary: string; truncated: boolean } | undefined {
  const rawSummary = item['summary']
  if (!Array.isArray(rawSummary)) return undefined

  const parts = rawSummary.flatMap((part) => {
    const text = stringValue(part)?.trim()
    return text !== undefined && text.length > 0 ? [text] : []
  })
  if (parts.length === 0) return undefined

  const selected = parts.slice(0, MAX_REASONING_SUMMARY_PARTS)
  const joined = selected.join('\n\n')
  const truncated = parts.length > selected.length || joined.length > MAX_REASONING_SUMMARY_CHARS
  return {
    summary: joined.slice(0, MAX_REASONING_SUMMARY_CHARS),
    truncated,
  }
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
