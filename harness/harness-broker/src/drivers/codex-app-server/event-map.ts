import type {
  InputId,
  InvocationEventFor,
  InvocationEventType,
  TurnId,
  UsageModelIdentity,
} from 'spaces-harness-broker-protocol'
import { asMessageId, asRecord, asToolCallId, asTurnId, stringValue } from './native-params'
import { mapCodexNotice } from './notices'
import { SUPPRESSED_METHODS } from './notification-methods'
import {
  type LastDiffSignatures,
  mapDiffUpdated,
  mapPlanUpdated,
  mapReasoningItem,
} from './progress-cards'
import type { JsonRpcNotification } from './rpc-client'
import { TOOL_TYPES, mapToolItemCompleted, mapToolItemStarted } from './tool-items'

export type MappedEventFor<K extends InvocationEventType> = InvocationEventFor<K> & {
  extra?: {
    turnId?: TurnId | undefined
    inputId?: InputId | undefined
    itemId?: string | undefined
    driver?: { kind: string; rawType?: string | undefined } | undefined
  }
}

export type MappedEvent = {
  [K in InvocationEventType]: MappedEventFor<K>
}[InvocationEventType]

export interface CodexErrorInfo {
  message: string
  code: string
  data: Record<string, unknown>
  retryable?: boolean | undefined
  reason?: string | undefined
}

/** Stable driver identity stamped onto every event derived from a native notification. */
export const CODEX_DRIVER_KIND = 'codex-app-server'

type HeldAssistantCompletions = Map<string, MappedEventFor<'assistant.message.completed'>>

export interface CodexNotificationMapperOptions {
  /**
   * The model serving this thread (T-08430). Codex's usage notification carries
   * no model of its own, so the driver — which sees the `thread/start` response
   * and every `model/rerouted` — supplies it. Read at emit time, not at
   * construction, so a reroute mid-thread lands on the next usage event.
   */
  modelIdentity?: (() => UsageModelIdentity | undefined) | undefined
}

export function createCodexNotificationMapper(
  options: CodexNotificationMapperOptions = {}
): (notification: JsonRpcNotification) => MappedEvent[] {
  const heldAssistantCompletions: HeldAssistantCompletions = new Map()
  const lastDiffSignatures: LastDiffSignatures = new Map()
  return (notification) =>
    mapCodexNotificationWithState(
      notification,
      heldAssistantCompletions,
      lastDiffSignatures,
      options.modelIdentity
    )
}

function mapCodexNotificationWithState(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures,
  modelIdentity?: (() => UsageModelIdentity | undefined) | undefined
): MappedEvent[] {
  const driver = { kind: CODEX_DRIVER_KIND, rawType: notification.method }
  return mapCodexNotificationInner(
    notification,
    heldAssistantCompletions,
    lastDiffSignatures,
    modelIdentity
  ).map((event) => ({
    ...event,
    extra: { ...event.extra, driver: event.extra?.driver ?? driver },
  }))
}

/**
 * Codex `unified_exec`: the MODEL wrote to a PTY session that is still open
 * (`write_stdin` tool, core/src/tools/handlers/unified_exec/write_stdin.rs).
 *
 * `itemId` is the owning `ExecCommandBegin` call_id — the same id already used as
 * `toolCallId` — so this is a continuation write into an IN-FLIGHT tool call, not
 * a new call and emphatically not operator input (that is `input.queued`).
 *
 * Unlike `outputDelta`, each fire carries one COMPLETE `chars` argument rather
 * than a fragment of a byte stream, so `deltas.join('')` is wrong here. The
 * `stream: 'stdin'` tag on `payload.data` is what lets the renderer keep input
 * and output distinct instead of smearing them into one blob.
 *
 * Empty stdin is a background-PTY liveness poll, not content — Codex's own TUI
 * routes it to a status indicator and never the transcript
 * (tui/src/chatwidget/command_lifecycle.rs:76). Dropping it is what keeps a
 * long-running background session from flooding the pane, and it is why this
 * method is handled here rather than left to the unknown-notification
 * diagnostic, which rendered a clipped `data={"params":{…}}` line per fire.
 */
function mapTerminalInteraction(
  params: Record<string, unknown>,
  heldAssistantCompletions: HeldAssistantCompletions
): MappedEvent[] {
  const turnId = stringValue(params['turnId'])
  const itemId = stringValue(params['itemId']) ?? stringValue(params['id'])
  const stdin = stringValue(params['stdin'])
  if (!turnId || !itemId) return []
  if (stdin === undefined || stdin.length === 0) return []
  return [
    ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
    {
      type: 'tool.call.delta',
      payload: {
        toolCallId: asToolCallId(itemId),
        text: stdin,
        data: { stream: 'stdin' },
      },
      extra: { turnId: asTurnId(turnId), itemId },
    },
  ]
}

function mapCodexNotificationInner(
  notification: JsonRpcNotification,
  heldAssistantCompletions: HeldAssistantCompletions,
  lastDiffSignatures: LastDiffSignatures,
  modelIdentity?: (() => UsageModelIdentity | undefined) | undefined
): MappedEvent[] {
  const params = asRecord(notification.params)
  const notice = mapCodexNotice(notification.method, params)
  if (notice !== undefined) return notice

  switch (notification.method) {
    case 'turn/started': {
      const turnId = stringValue(params['turnId']) ?? stringValue(asRecord(params['turn'])['id'])
      if (!turnId) return []
      heldAssistantCompletions.delete(turnId)
      lastDiffSignatures.delete(turnId)
      return [
        {
          type: 'turn.started',
          payload: { turnId: asTurnId(turnId) },
          extra: { turnId: asTurnId(turnId) },
        },
      ]
    }

    case 'thread/tokenUsage/updated': {
      const usage = params['usage'] ?? params['tokenUsage'] ?? params['token_usage']
      const model = modelIdentity?.()
      return [
        { type: 'usage.updated', payload: { usage, ...(model !== undefined ? { model } : {}) } },
      ]
    }

    case 'turn/plan/updated':
      return mapPlanUpdated(params)

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
            payload: { messageId: asMessageId(itemId) },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          mapToolItemStarted(itemType, item, turnId, itemId),
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
          payload: { messageId: asMessageId(itemId), text },
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
          payload: { toolCallId: asToolCallId(itemId), text },
          extra: { turnId: asTurnId(turnId), itemId },
        },
      ]
    }

    case 'item/commandExecution/terminalInteraction':
      return mapTerminalInteraction(params, heldAssistantCompletions)

    case 'item/mcpToolCall/progress': {
      const turnId = stringValue(params['turnId'])
      const itemId = stringValue(params['id']) ?? stringValue(params['itemId'])
      if (!turnId || !itemId) return []
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
        {
          type: 'tool.call.delta',
          payload: {
            toolCallId: asToolCallId(itemId),
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

      if (itemType === 'reasoning') return mapReasoningItem(item, turnId, itemId)

      // T-07726 — the provider compacted the thread's context mid-invocation.
      // Previously dropped with every other unmodelled item type, which hid a
      // real transcript discontinuity from the operator. The item carries only
      // its id, so the event is the fact itself.
      if (itemType === 'contextCompaction') {
        return [
          {
            type: 'diagnostic',
            payload: {
              level: 'info',
              source: 'driver',
              kind: 'compaction',
              message: 'Codex compacted the thread context',
            },
            extra: { turnId: asTurnId(turnId), itemId },
          },
        ]
      }

      if (TOOL_TYPES.has(itemType)) {
        return [
          ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, false),
          mapToolItemCompleted(itemType, item, itemId, turnId),
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
      const finalOutput = stringValue(params['finalOutput']) ?? stringValue(turn['finalOutput'])
      const terminal: MappedEvent =
        status === 'failed'
          ? {
              type: 'turn.failed',
              payload: {
                turnId: asTurnId(turnId),
                status,
                message: failedTurnMessage(finalOutput),
                ...(finalOutput !== undefined ? { finalOutput } : {}),
              },
            }
          : status === 'interrupted'
            ? {
                type: 'turn.interrupted',
                payload: {
                  turnId: asTurnId(turnId),
                  status,
                  ...(finalOutput !== undefined ? { finalOutput } : {}),
                },
              }
            : {
                type: 'turn.completed',
                payload: {
                  turnId: asTurnId(turnId),
                  status,
                  ...(finalOutput !== undefined ? { finalOutput } : {}),
                },
              }
      return [
        ...flushHeldAssistantCompletion(heldAssistantCompletions, turnId, true),
        {
          ...terminal,
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
      // `extra.driver.rawType` (the single method authority — never duplicated
      // into `payload.data`); the raw params ride on `payload.data.params` so a
      // genuinely-novel method is legible on the durable stream and in-pane
      // instead of a bare method name (T-05219). Data-less debug diagnostics are
      // still folded out of the pane by the renderer.
      return [
        {
          type: 'diagnostic',
          payload: {
            level: 'debug',
            message: `Unhandled Codex notification: ${notification.method}`,
            source: 'driver',
            data: { params: notification.params ?? {} },
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
): MappedEventFor<'assistant.message.completed'> {
  return {
    type: 'assistant.message.completed',
    payload: {
      messageId: asMessageId(itemId),
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
      payload: { ...held.payload, final },
    },
  ]
}

export function parseCodexError(params: unknown): CodexErrorInfo {
  const root = asRecord(params)
  const nested = asRecord(root['error'])
  const rawMessage = stringValue(root['message']) ?? stringValue(nested['message'])
  const message =
    rawMessage !== undefined && rawMessage.trim().length > 0 ? rawMessage : 'Codex app-server error'
  const codexErrorInfo = nested['codexErrorInfo']
  const code =
    stringValue(root['code']) ??
    stringValue(nested['code']) ??
    stringValue(codexErrorInfo) ??
    stringValue(asRecord(codexErrorInfo)['code']) ??
    'codex_app_server_error'
  const retryable = typeof root['willRetry'] === 'boolean' ? root['willRetry'] : undefined
  const reason = stringValue(root['reason']) ?? stringValue(nested['reason'])
  const data = { ...root, code }
  return {
    message,
    code,
    data,
    ...(retryable !== undefined ? { retryable } : {}),
    ...(reason !== undefined ? { reason } : {}),
  }
}

function failedTurnMessage(finalOutput: string | undefined): string {
  return finalOutput !== undefined && finalOutput.trim().length > 0
    ? finalOutput
    : 'Codex turn failed'
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
