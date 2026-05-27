import type {
  InvocationEventEnvelope,
  InvocationEventPayload,
  InvocationEventType,
  InvocationId,
  MessageId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'

export const CODEX_CLI_TMUX_DRIVER_KIND = 'codex-cli-tmux'

export type CodexCliTmuxHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
}

export type CodexCliTmuxHookEventNormalizerOptions = {
  invocationId: string
  now: () => Date
}

export type CodexCliTmuxHookEnvelope = {
  invocationId?: string | undefined
  generation?: number | undefined
  callbackSocket?: string | undefined
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData?: unknown
  hookEvent?: unknown
  payload?: unknown
}

export type NormalizeCodexHookEnvelopeOptions = {
  normalizer?: CodexCliTmuxHookEventNormalizer | undefined
  now?: (() => Date) | undefined
}

export function normalizeCodexHookEnvelope(
  envelope: CodexCliTmuxHookEnvelope,
  options: NormalizeCodexHookEnvelopeOptions = {}
): InvocationEventEnvelope[] {
  const invocationId = envelope.invocationId ?? 'inv_codex_cli_tmux'
  const normalizer =
    options.normalizer ??
    createCodexCliTmuxHookEventNormalizer({
      invocationId,
      now: options.now ?? (() => new Date()),
    })
  const hook = asHookRecord(envelope.hookData ?? envelope.hookEvent ?? envelope.payload ?? envelope)
  const merged =
    envelope.turnId !== undefined && getString(hook, 'turn_id') === undefined
      ? { ...hook, turn_id: envelope.turnId }
      : hook
  return normalizer.normalizeHook(merged)
}

type MappedHookEvent = {
  type: InvocationEventType
  payload: unknown
  turnId?: TurnId | undefined
  itemId?: string | undefined
  correlation?: Record<string, string> | undefined
}

type ActiveTool = {
  toolCallId: string
  name: string
  input: unknown
}

export function createCodexCliTmuxHookEventNormalizer(
  options: CodexCliTmuxHookEventNormalizerOptions
): CodexCliTmuxHookEventNormalizer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const activeToolsByTurnAndCommand = new Map<string, ActiveTool>()
  let permissionCounter = 0
  let messageCounter = 0

  const emit = (rawType: string, event: MappedHookEvent): InvocationEventEnvelope => {
    const envelope = sequencer.next(
      invocationId,
      event.type,
      event.payload as InvocationEventPayload,
      {
        ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
        ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
        driver: { kind: CODEX_CLI_TMUX_DRIVER_KIND, rawType },
      }
    )
    if (event.correlation !== undefined) {
      envelope.correlation = event.correlation
    }
    return envelope
  }

  return {
    normalizeHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
      const unwrapped = unwrapHookPayload(hook)
      const rawType = getString(unwrapped, 'hook_event_name') ?? 'unknown'
      const turnIdText = getString(unwrapped, 'turn_id')
      const sessionId = getString(unwrapped, 'session_id')
      const turnId = turnIdText !== undefined ? (turnIdText as TurnId) : undefined

      if (rawType === 'UserPromptSubmit') {
        if (turnIdText === undefined || turnId === undefined) return []
        return [
          emit(rawType, {
            type: 'turn.started',
            payload: {
              turnId: turnIdText,
              ...(sessionId !== undefined ? { sessionId } : {}),
              ...(typeof unwrapped['prompt'] === 'string' ? { prompt: unwrapped['prompt'] } : {}),
            },
            turnId,
          }),
        ]
      }

      if (rawType === 'PreToolUse') {
        const toolCallId = getString(unwrapped, 'tool_use_id')
        if (turnId === undefined || turnIdText === undefined || toolCallId === undefined) return []
        const name = getString(unwrapped, 'tool_name') ?? 'tool'
        const input = unwrapped['tool_input']
        const command = commandFromToolInput(input)
        if (command !== undefined) {
          activeToolsByTurnAndCommand.set(toolKey(turnIdText, command), {
            toolCallId,
            name,
            input,
          })
        }
        return [
          emit(rawType, {
            type: 'tool.call.started',
            payload: {
              toolCallId: toolCallId as ToolCallId,
              name,
              ...(input !== undefined ? { input } : {}),
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (rawType === 'PostToolUse') {
        const toolCallId = getString(unwrapped, 'tool_use_id')
        if (turnId === undefined || toolCallId === undefined) return []
        const name = getString(unwrapped, 'tool_name') ?? 'tool'
        const { output, details } = formatToolResult(
          unwrapped['tool_input'],
          unwrapped['tool_response']
        )
        return [
          emit(rawType, {
            type: 'tool.call.completed',
            payload: {
              toolCallId: toolCallId as ToolCallId,
              name,
              isError: false,
              result: {
                output: output ?? '',
                content: [{ type: 'text', text: output ?? '' }],
                ...(details !== undefined ? { details } : {}),
              },
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (rawType === 'PermissionRequest') {
        if (turnId === undefined || turnIdText === undefined) return []
        const command = commandFromToolInput(unwrapped['tool_input'])
        const activeTool =
          command !== undefined
            ? activeToolsByTurnAndCommand.get(toolKey(turnIdText, command))
            : undefined
        permissionCounter += 1
        return [
          emit(rawType, {
            type: 'permission.requested',
            payload: {
              permissionRequestId:
                `perm_${options.invocationId}_${permissionCounter}` as PermissionRequestId,
              kind: command !== undefined ? 'command' : 'tool',
              subjectDisplay:
                command !== undefined
                  ? { command }
                  : (unwrapped['tool_input'] ?? unwrapped['tool_name'] ?? {}),
              defaultDecision: 'deny',
            },
            turnId,
            ...(activeTool !== undefined
              ? { correlation: { toolCallId: activeTool.toolCallId } }
              : {}),
          }),
        ]
      }

      if (rawType === 'Stop') {
        if (turnIdText === undefined || turnId === undefined) return []
        const finalOutput = getString(unwrapped, 'last_assistant_message') ?? ''
        messageCounter += 1
        const messageId = `msg_${options.invocationId}_${messageCounter}` as MessageId
        const events: InvocationEventEnvelope[] = [
          emit(rawType, {
            type: 'assistant.message.completed',
            payload: {
              messageId,
              content: [{ type: 'text', text: finalOutput }],
              final: true,
            },
            turnId,
            itemId: messageId,
          }),
          emit(rawType, {
            type: 'turn.completed',
            payload: {
              turnId: turnIdText,
              status: 'completed',
              finalOutput,
              producedContent: finalOutput.length > 0,
            },
            turnId,
          }),
        ]
        if (sessionId !== undefined) {
          events.push(
            emit(rawType, {
              type: 'continuation.updated',
              payload: { provider: 'openai', kind: 'session', key: sessionId },
            })
          )
        }
        return events
      }

      return []
    },
  }
}

function unwrapHookPayload(hook: Record<string, unknown>): Record<string, unknown> {
  if (typeof hook['hook_event_name'] === 'string') return hook
  const hookEvent = hook['hookEvent']
  if (hookEvent !== null && typeof hookEvent === 'object' && !Array.isArray(hookEvent)) {
    const inner = hookEvent as Record<string, unknown>
    if (typeof inner['hook_event_name'] === 'string') return inner
  }
  return hook
}

function asHookRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function formatToolResult(
  toolInput: unknown,
  toolResponse: unknown
): { output?: string | undefined; details?: Record<string, unknown> | undefined } {
  const command = commandFromToolInput(toolInput)
  if (typeof toolResponse === 'string') {
    return {
      output: toolResponse,
      details: {
        ...(command !== undefined ? { command } : {}),
        response: toolResponse,
      },
    }
  }
  if (toolResponse !== null && typeof toolResponse === 'object' && !Array.isArray(toolResponse)) {
    const response = toolResponse as Record<string, unknown>
    const stdout = typeof response['stdout'] === 'string' ? response['stdout'] : undefined
    const stderr = typeof response['stderr'] === 'string' ? response['stderr'] : undefined
    return {
      output: stdout ?? stderr,
      details: {
        ...(command !== undefined ? { command } : {}),
        response,
      },
    }
  }
  return {
    details: command !== undefined ? { command, response: toolResponse ?? '' } : undefined,
  }
}

function commandFromToolInput(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const command = (value as Record<string, unknown>)['command']
  return typeof command === 'string' ? command : undefined
}

function toolKey(turnId: string, command: string): string {
  return `${turnId}\0${command}`
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}
