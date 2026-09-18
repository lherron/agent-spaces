/**
 * MSP notification → broker InvocationEvent mapping (T-08589, spike 3).
 *
 * Every method name below is schema- or probe-verified against muse 1.3.0
 * (offline schema export fingerprint
 * sha256:ab69549a7ebb423fce94068762da0b5ff3cdec1f8fc263dcc17248eda117f852
 * plus credential-free echo-turn probes). turn/completed terminal vocabulary
 * (completed|failed|cancelled), the authRequired failure shape, and the
 * commandRejected/missing_run fence were all OBSERVED live; assistant
 * delta shapes beyond userMessage are schema-derived and marked
 * accordingly — the MATRIX model row promotes them to observed. toolCall
 * turn-item fields (tool, callId, args, visibleOutput, failureReason) are
 * verified against the 1.3.0 schema export.
 */
import type {
  InputId,
  InvocationEvent,
  InvocationEventPayloadMap,
  InvocationEventType,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { MuseJsonRpcNotification } from './rpc-client'

export const MUSE_DRIVER_KIND = 'muse-serve'

export type MappedEventFor<K extends InvocationEventType> = {
  type: K
  payload: InvocationEventPayloadMap[K]
  extra?: {
    turnId?: TurnId | undefined
    inputId?: InputId | undefined
    itemId?: string | undefined
  }
}

export type MappedEvent = {
  [K in InvocationEventType]: MappedEventFor<K>
}[InvocationEventType]

export type MuseMethodClass = 'mapped' | 'ignored-known' | 'unknown'

const MAPPED_METHODS = new Set([
  'turn/started',
  'turn/completed',
  'turn/retracted',
  'item/started',
  'item/delta',
  'item/updated',
  'item/completed',
  'session/tokenUsage',
  'usage/changed',
  'session/contextUsage',
  'view/gap',
])

const IGNORED_KNOWN_METHODS = new Set([
  'initialized',
  'session/started',
  'session/statusChanged',
  'session/approvalModeChanged',
  'session/branchChanged',
  'session/goalChanged',
  'session/modelChanged',
  'session/modelRouteUnserved',
  'session/nameChanged',
  'session/reasoningEffortChanged',
  'session/todoListChanged',
  'session/viewHealthChanged',
  'skill/changed',
  'approval/requested',
  'approval/updated',
  'approval/resolved',
  'userInput/requested',
  'userInput/settled',
  'turn/unqueued',
  'turn/retryScheduled',
])

export function classifyMuseNotificationMethod(method: string): MuseMethodClass {
  if (MAPPED_METHODS.has(method)) return 'mapped'
  if (IGNORED_KNOWN_METHODS.has(method)) return 'ignored-known'
  return 'unknown'
}

export interface MuseMapObserver {
  /** Agent-visible text observed on the transcript (steer-landing evidence). */
  onAgentText?: ((turnId: string, text: string) => void) | undefined
}

type Params = Record<string, unknown>

function paramsOf(notification: MuseJsonRpcNotification): Params {
  const params = notification.params
  return params !== null && typeof params === 'object' && !Array.isArray(params)
    ? (params as Params)
    : {}
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/**
 * Project MSP verbatim args JSON into a tool-call input. Parses when the
 * model emitted valid JSON, otherwise carries the raw string; absent when
 * there are no args at all.
 */
function argsInput(value: unknown): { input?: unknown } {
  const raw = stringField(value)
  if (raw === undefined) return {}
  try {
    return { input: JSON.parse(raw) as unknown }
  } catch {
    return { input: raw }
  }
}

function diagnostic(
  level: 'debug' | 'info' | 'warn' | 'error',
  message: string,
  extra?: { turnId?: TurnId | undefined; data?: unknown }
): MappedEvent {
  return {
    type: 'diagnostic',
    payload: {
      level,
      message,
      source: 'driver',
      kind: 'muse-serve',
      ...(extra?.data !== undefined ? { data: extra.data } : {}),
    },
    ...(extra?.turnId !== undefined ? { extra: { turnId: extra.turnId } } : {}),
  }
}

function mapTurnCompleted(params: Params, observer?: MuseMapObserver): MappedEvent[] {
  const turnId = stringField(params['turnId'])
  if (!turnId) {
    return [diagnostic('warn', 'muse-serve turn/completed without turnId')]
  }
  const turn = turnId as TurnId
  const terminal = stringField(params['terminal'])
  const usage = params['usage']
  const events: MappedEvent[] = []
  if (terminal === 'completed') {
    events.push({
      type: 'turn.completed',
      payload: {
        turnId: turn,
        status: 'completed',
        ...(usage !== undefined && usage !== null ? { usage } : {}),
      },
      extra: { turnId: turn },
    })
  } else if (terminal === 'cancelled') {
    events.push({
      type: 'turn.interrupted',
      payload: {
        turnId: turn,
        status: 'interrupted',
        ...(typeof params['reason'] === 'string' ? { reason: params['reason'] } : {}),
      },
      extra: { turnId: turn },
    })
  } else {
    const error =
      params['error'] !== null && typeof params['error'] === 'object'
        ? (params['error'] as Params)
        : {}
    const message =
      stringField(error['message']) ??
      stringField(params['reason']) ??
      `turn ${terminal ?? 'failed'}`
    events.push({
      type: 'turn.failed',
      payload: {
        turnId: turn,
        message,
        ...(stringField(error['kind']) ? { code: error['kind'] as string } : {}),
        ...(typeof error['retryable'] === 'boolean' ? { retryable: error['retryable'] } : {}),
        ...(usage !== undefined && usage !== null
          ? { finalOutput: undefined, data: { usage } }
          : {}),
      },
      extra: { turnId: turn },
    })
  }
  if (usage !== undefined && usage !== null) {
    events.push({ type: 'usage.updated', payload: { usage }, extra: { turnId: turn } })
  }
  void observer
  return events
}

function itemRecord(params: Params): Params | undefined {
  const item = params['item']
  return item !== null && typeof item === 'object' && !Array.isArray(item)
    ? (item as Params)
    : undefined
}

function mapItemEvent(
  method: 'item/started' | 'item/updated' | 'item/completed',
  params: Params,
  observer?: MuseMapObserver
): MappedEvent[] {
  const item = itemRecord(params)
  if (!item) return [diagnostic('warn', `muse-serve ${method} without item`)]
  const kind = stringField(item['kind']) ?? 'unknown'
  const status = stringField(item['status']) ?? ''
  const turnId = stringField(item['turnId'] ?? params['turnId'])
  const turn = turnId !== undefined ? (turnId as TurnId) : undefined
  const itemId = stringField(item['itemId'])
  const text = stringField(item['text']) ?? stringField(item['output']) ?? ''

  if (kind === 'userMessage') {
    return []
  }
  if (kind === 'agentMessage') {
    if (method !== 'item/completed') {
      return [
        {
          type: 'assistant.message.started',
          payload: { messageId: (itemId ?? turnId ?? 'unknown') as MessageId },
          ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
        },
      ]
    }
    if (text) observer?.onAgentText?.(turnId ?? '', text)
    return [
      {
        type: 'assistant.message.completed',
        payload: {
          messageId: (itemId ?? turnId ?? 'unknown') as MessageId,
          content: [{ type: 'text', text }],
          final: true,
        },
        ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
      },
    ]
  }
  if (kind === 'toolCall') {
    // Turn-item shape (schema-verified against muse 1.3.0): the tool name is
    // `tool`, the call id is `callId`, args ride verbatim JSON in `args`,
    // result text is `visibleOutput`, failure text is `failureReason`.
    // toolName/name, toolCallId, input, output, and text are fallbacks for
    // approval-adjacent shapes.
    const toolCallId = (stringField(item['callId']) ??
      stringField(item['toolCallId']) ??
      itemId ??
      'unknown') as ToolCallId
    const name =
      stringField(item['tool']) ??
      stringField(item['toolName']) ??
      stringField(item['name']) ??
      'unknown'
    const terminal = status !== 'inProgress'
    if (!terminal) {
      return [
        {
          type: 'tool.call.started',
          payload: {
            toolCallId,
            name,
            ...(item['input'] !== undefined ? { input: item['input'] } : argsInput(item['args'])),
          },
          ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
        },
      ]
    }
    if (status === 'completed') {
      return [
        {
          type: 'tool.call.completed',
          payload: {
            toolCallId,
            name,
            ...(item['output'] !== undefined
              ? { result: item['output'] }
              : item['visibleOutput'] !== undefined
                ? { result: item['visibleOutput'] }
                : {}),
          },
          ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
        },
      ]
    }
    return [
      {
        type: 'tool.call.failed',
        payload: {
          toolCallId,
          name,
          message: stringField(item['failureReason']) || text || `tool call ${status}`,
          code: status || 'unknown',
        },
        ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
      },
    ]
  }
  if (kind === 'reasoning') {
    if (method === 'item/completed' && text) {
      return [
        diagnostic(
          'debug',
          `muse-serve reasoning: ${text.slice(0, 500)}`,
          turn ? { turnId: turn } : undefined
        ),
      ]
    }
    return []
  }
  return []
}

function mapItemDelta(params: Params, observer?: MuseMapObserver): MappedEvent[] {
  const itemId = stringField(params['itemId'])
  const turnId = stringField(params['turnId'])
  const turn = turnId !== undefined ? (turnId as TurnId) : undefined
  const delta = stringField(params['delta']) ?? ''
  const field = stringField(params['field']) ?? 'text'
  if (!delta) return []
  if (field === 'text' || field.startsWith('text')) {
    observer?.onAgentText?.(turnId ?? '', delta)
    return [
      {
        type: 'assistant.message.delta',
        payload: { messageId: (itemId ?? turnId ?? 'unknown') as MessageId, text: delta },
        ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
      },
    ]
  }
  return [
    {
      type: 'tool.call.delta',
      payload: {
        toolCallId: (itemId ?? 'unknown') as ToolCallId,
        text: delta,
        data: { field },
      },
      ...(turn !== undefined ? { extra: { turnId: turn } } : {}),
    },
  ]
}

/**
 * Map one MSP notification to broker events. Pure: approval.* and
 * userInput.* are intentionally NOT mapped here — the driver answers those
 * server-initiated requests through the permission module (async), while this
 * map stays a total function over transcript/usage/turn facts.
 */
export function mapMuseNotification(
  notification: MuseJsonRpcNotification,
  observer?: MuseMapObserver
): MappedEvent[] {
  const method = notification.method
  const params = paramsOf(notification)
  switch (method) {
    case 'turn/started': {
      const turnId = stringField(params['turnId'])
      if (!turnId) return [diagnostic('warn', 'muse-serve turn/started without turnId')]
      return [
        {
          type: 'turn.started',
          payload: {
            turnId: turnId as TurnId,
            source: 'broker-delivery',
            ...(stringField(params['sessionId'])
              ? { sessionId: params['sessionId'] as string }
              : {}),
          },
          extra: { turnId: turnId as TurnId },
        },
      ]
    }
    case 'turn/completed':
      return mapTurnCompleted(params, observer)
    case 'turn/retracted':
      return [
        diagnostic('info', 'muse-serve turn retracted', {
          ...(stringField(params['turnId']) ? { turnId: params['turnId'] as TurnId } : {}),
        }),
      ]
    case 'item/started':
    case 'item/updated':
    case 'item/completed':
      return mapItemEvent(method, params, observer)
    case 'item/delta':
      return mapItemDelta(params, observer)
    case 'session/tokenUsage':
    case 'usage/changed':
      return params['usage'] !== undefined && params['usage'] !== null
        ? [{ type: 'usage.updated', payload: { usage: params['usage'] } }]
        : []
    case 'session/contextUsage':
      return [diagnostic('debug', 'muse-serve context usage', { data: params })]
    case 'view/gap':
      return [
        diagnostic('warn', 'muse-serve view gap: events may have been missed', { data: params }),
      ]
    default: {
      const classification = classifyMuseNotificationMethod(method)
      if (classification === 'ignored-known') return []
      return [diagnostic('debug', `muse-serve: unmapped notification ${method}`)]
    }
  }
}

export type { InvocationEvent }
