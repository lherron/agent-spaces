import type {
  InvocationEventEnvelope,
  InvocationEventPayload,
  InvocationEventType,
  InvocationId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import { asRecord, getString } from '../hook-json'
import type { PiTuiTmuxHookEnvelope } from './hook-ingestion'

export const PI_TUI_TMUX_DRIVER_KIND = 'pi-tui-tmux'

export type PiTuiTmuxHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
}

export type PiTuiTmuxHookEventNormalizerOptions = {
  invocationId: string
  now: () => Date
  allocateTurnId?: (() => string) | undefined
}

export type NormalizePiHookEnvelopeOptions = {
  normalizer?: PiTuiTmuxHookEventNormalizer | undefined
  now?: (() => Date) | undefined
}

type MappedHookEvent = {
  type: InvocationEventType
  payload: unknown
  turnId?: TurnId | undefined
  itemId?: string | undefined
}

type HeldAssistantMessage = {
  messageId: string
  content: string
  turnId?: TurnId | undefined
}

export function normalizePiHookEnvelope(
  envelope: PiTuiTmuxHookEnvelope,
  options: NormalizePiHookEnvelopeOptions = {}
): InvocationEventEnvelope[] {
  const normalizer =
    options.normalizer ??
    createPiTuiTmuxHookEventNormalizer({
      invocationId: envelope.invocationId,
      now: options.now ?? (() => new Date()),
    })
  const hook = asRecord(envelope.hookData) ?? {}
  const merged =
    envelope.turnId !== undefined && getString(hook, 'turn_id') === undefined
      ? { ...hook, turn_id: envelope.turnId }
      : hook
  return normalizer.normalizeHook(merged)
}

export function createPiTuiTmuxHookEventNormalizer(
  options: PiTuiTmuxHookEventNormalizerOptions
): PiTuiTmuxHookEventNormalizer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  let turnCounter = 0
  let activeTurnId: string | undefined
  let agentActive = false
  let heldAssistantMessage: HeldAssistantMessage | undefined

  const allocateTurnId =
    options.allocateTurnId ??
    (() => {
      turnCounter += 1
      return `turn_${options.invocationId}_${turnCounter}`
    })

  const emit = (rawType: string, event: MappedHookEvent): InvocationEventEnvelope => {
    return sequencer.next(invocationId, event.type, event.payload as InvocationEventPayload, {
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
      driver: { kind: PI_TUI_TMUX_DRIVER_KIND, rawType },
    })
  }

  const flushHeld = (
    final: boolean,
    fallbackTurnId?: TurnId | undefined
  ): InvocationEventEnvelope[] => {
    if (heldAssistantMessage === undefined) return []
    const message = heldAssistantMessage
    heldAssistantMessage = undefined
    return [
      emit('message_end', {
        type: 'assistant.message.completed',
        payload: {
          messageId: message.messageId,
          content: [{ type: 'text', text: message.content }],
          final,
        },
        turnId: message.turnId ?? fallbackTurnId,
        itemId: message.messageId,
      }),
    ]
  }

  return {
    normalizeHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
      const eventName = getString(hook, 'eventName') ?? getString(hook, 'type') ?? 'unknown'
      const payload = asRecord(hook['payload']) ?? hook
      const rawTurnId = getString(hook, 'turn_id') ?? getString(payload, 'turnId')
      const turnIdText = rawTurnId ?? activeTurnId
      const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined

      if (eventName === 'session_start') {
        const sessionId = getString(payload, 'sessionId')
        if (sessionId === undefined || sessionId.length === 0) return []
        return [
          emit(eventName, {
            type: 'continuation.updated',
            payload: { provider: 'openai', kind: 'session', key: sessionId },
          }),
        ]
      }

      if (eventName === 'agent_start') {
        agentActive = true
        heldAssistantMessage = undefined
        const resolved = turnIdText ?? allocateTurnId()
        activeTurnId = resolved
        return [
          emit(eventName, {
            type: 'turn.started',
            payload: { turnId: resolved, source: 'hook-observed' },
            turnId: resolved as TurnId,
          }),
        ]
      }

      if (eventName === 'turn_start') {
        const resolved = turnIdText ?? activeTurnId ?? allocateTurnId()
        activeTurnId = resolved
        return [
          emit(eventName, {
            type: 'turn.started',
            payload: { turnId: resolved, source: 'hook-observed' },
            turnId: resolved as TurnId,
          }),
        ]
      }

      if (eventName === 'message_update') {
        const messageId = getString(payload, 'messageId') ?? `${turnIdText ?? 'turn'}_message`
        const assistantMessageEvent = asRecord(payload['assistantMessageEvent'])
        const delta =
          getString(assistantMessageEvent, 'delta') ??
          getString(assistantMessageEvent, 'text') ??
          getString(payload, 'delta') ??
          getString(payload, 'textDelta')
        if (turnId === undefined || delta === undefined || delta.length === 0) return []
        return [
          emit(eventName, {
            type: 'assistant.message.delta',
            payload: { messageId, text: delta },
            turnId,
            itemId: messageId,
          }),
        ]
      }

      if (eventName === 'message_end') {
        const message = asRecord(payload['message'])
        if (message?.['role'] !== 'assistant') return []
        const content = assistantTextFromMessage(message)
        if (content === undefined) return []
        const messageId = getString(payload, 'messageId') ?? `${turnIdText ?? 'turn'}_message`
        const flushed = flushHeld(false, turnId)
        heldAssistantMessage = { messageId, content, ...(turnId !== undefined ? { turnId } : {}) }
        return flushed
      }

      if (eventName === 'tool_execution_start') {
        const toolCallId = getString(payload, 'toolCallId')
        if (turnId === undefined || toolCallId === undefined) return []
        const name = getString(payload, 'toolName') ?? 'tool'
        return [
          emit(eventName, {
            type: 'tool.call.started',
            payload: {
              toolCallId: toolCallId as ToolCallId,
              name,
              ...(payload['args'] !== undefined ? { input: payload['args'] } : {}),
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (eventName === 'tool_execution_update') {
        const toolCallId = getString(payload, 'toolCallId')
        if (turnId === undefined || toolCallId === undefined) return []
        return [
          emit(eventName, {
            type: 'tool.call.delta',
            payload: {
              toolCallId: toolCallId as ToolCallId,
              ...(payload['partialResult'] !== undefined
                ? { data: payload['partialResult'], text: toolResultText(payload['partialResult']) }
                : {}),
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (eventName === 'tool_execution_end') {
        const toolCallId = getString(payload, 'toolCallId')
        if (turnId === undefined || toolCallId === undefined) return []
        const name = getString(payload, 'toolName') ?? 'tool'
        const output = toolResultText(payload['result']) ?? ''
        return [
          emit(eventName, {
            type: 'tool.call.completed',
            payload: {
              toolCallId: toolCallId as ToolCallId,
              name,
              isError: payload['isError'] === true,
              result: {
                output,
                content: [{ type: 'text', text: output }],
                ...(payload['result'] !== undefined ? { details: payload['result'] } : {}),
              },
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (eventName === 'agent_end') {
        const events = flushHeld(true, turnId)
        if (turnIdText !== undefined && turnId !== undefined) {
          events.push(
            emit(eventName, {
              type: 'turn.completed',
              payload: {
                turnId: turnIdText,
                status: 'completed',
                producedContent: events.length > 0,
              },
              turnId,
            })
          )
        }
        activeTurnId = undefined
        agentActive = false
        return events
      }

      if (eventName === 'turn_end' && !agentActive) {
        const events = flushHeld(true, turnId)
        if (turnIdText !== undefined && turnId !== undefined) {
          events.push(
            emit(eventName, {
              type: 'turn.completed',
              payload: {
                turnId: turnIdText,
                status: 'completed',
                producedContent: events.length > 0,
              },
              turnId,
            })
          )
        }
        activeTurnId = undefined
        return events
      }

      if (eventName === 'session_shutdown') {
        activeTurnId = undefined
        agentActive = false
        heldAssistantMessage = undefined
        return []
      }

      return []
    },
  }
}

function assistantTextFromMessage(message: Record<string, unknown>): string | undefined {
  const content = message['content']
  if (typeof content === 'string') {
    return content.trim().length > 0 ? content : undefined
  }
  if (!Array.isArray(content)) return undefined
  const text = content
    .map((block) => {
      const record = asRecord(block)
      return record?.['type'] === 'text' && typeof record['text'] === 'string' ? record['text'] : ''
    })
    .join('')
  return text.trim().length > 0 ? text : undefined
}

function toolResultText(result: unknown): string | undefined {
  if (typeof result === 'string') return result
  const record = asRecord(result)
  if (record === undefined) return undefined
  if (typeof record['stdout'] === 'string') return record['stdout']
  if (typeof record['stderr'] === 'string') return record['stderr']
  const content = record['content']
  if (Array.isArray(content)) {
    const text = content
      .map((block) => {
        const item = asRecord(block)
        return item?.['type'] === 'text' && typeof item['text'] === 'string' ? item['text'] : ''
      })
      .join('')
    return text.length > 0 ? text : undefined
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}
