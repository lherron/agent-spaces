import type {
  InvocationEventEnvelope,
  InvocationEventPayload,
  InvocationEventType,
  InvocationId,
  PermissionRequestId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'

export const CLAUDE_CODE_TMUX_DRIVER_KIND = 'claude-code-tmux'

export type ClaudeCodeHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
  normalizeToolCallFailure: (failure: {
    turnId: string
    toolCallId: string
    name: string
    message: string
    code?: string | undefined
    data?: unknown
  }) => InvocationEventEnvelope
}

export type ClaudeCodeHookEventNormalizerOptions = {
  invocationId: string
  now: () => Date
}

/**
 * Hook envelope as delivered by the broker hook-ingestion callback socket
 * (`buildHookEnvelope`). The real Claude turn id lives at the ENVELOPE/env
 * level (`HARNESS_BROKER_TURN_ID`), NOT inside the raw hook JSON — Claude does
 * not emit `turn_id` in its hook payloads. `normalizeHookEnvelope` threads the
 * envelope turn id into normalization so turn lifecycle events carry it.
 */
export type ClaudeCodeHookEnvelope = {
  invocationId: string
  generation: number
  callbackSocket: string
  runtimeId?: string | undefined
  turnId?: string | undefined
  hookData: unknown
}

export type NormalizeHookEnvelopeOptions = {
  /**
   * Reuse a stateful normalizer across envelopes (preserves activeTurnId /
   * completed-turn dedup / monotonic sequence). When omitted a fresh one-shot
   * normalizer is created per call (sufficient because the envelope always
   * supplies the turn id).
   */
  normalizer?: ClaudeCodeHookEventNormalizer | undefined
  now?: (() => Date) | undefined
}

/**
 * Normalize a single hook envelope into broker events, using the ENVELOPE turn
 * id (cody's Phase 3 seam) when the raw hook payload omits `turn_id`.
 */
export function normalizeHookEnvelope(
  envelope: ClaudeCodeHookEnvelope,
  options: NormalizeHookEnvelopeOptions = {}
): InvocationEventEnvelope[] {
  const normalizer =
    options.normalizer ??
    createClaudeCodeHookEventNormalizer({
      invocationId: envelope.invocationId,
      now: options.now ?? (() => new Date()),
    })

  const hook = asHookRecord(envelope.hookData)
  const merged =
    envelope.turnId !== undefined && getString(hook, 'turn_id') === undefined
      ? { ...hook, turn_id: envelope.turnId }
      : hook

  return normalizer.normalizeHook(merged)
}

function asHookRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

type MappedHookEvent = {
  type: InvocationEventType
  payload: unknown
  turnId?: TurnId | undefined
  itemId?: string | undefined
}

type MessageContent =
  | Array<{ type: string; text?: string | undefined; [key: string]: unknown }>
  | string

export function createClaudeCodeHookEventNormalizer(
  options: ClaudeCodeHookEventNormalizerOptions
): ClaudeCodeHookEventNormalizer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const completedTurns = new Set<string>()
  let activeTurnId: string | undefined

  const emit = (rawType: string, event: MappedHookEvent): InvocationEventEnvelope => {
    return sequencer.next(invocationId, event.type, event.payload as InvocationEventPayload, {
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
      driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType },
    })
  }

  return {
    normalizeHook(hook: Record<string, unknown>): InvocationEventEnvelope[] {
      const unwrapped = unwrapHookPayload(hook)
      const rawType = getString(unwrapped, 'hook_event_name') ?? 'unknown'
      const turnIdText = getString(unwrapped, 'turn_id') ?? activeTurnId
      const turnId = turnIdText !== undefined ? asTurnId(turnIdText) : undefined

      if (rawType === 'UserPromptSubmit') {
        if (turnIdText === undefined || turnId === undefined) return []
        activeTurnId = turnIdText
        return [
          emit(rawType, {
            type: 'turn.started',
            payload: { turnId: turnIdText },
            turnId,
          }),
        ]
      }

      if (rawType === 'PreToolUse') {
        const toolCallId = getString(unwrapped, 'tool_use_id')
        if (turnId === undefined || toolCallId === undefined) return []
        return [
          emit(rawType, {
            type: 'tool.call.started',
            payload: {
              toolCallId,
              name: getString(unwrapped, 'tool_name') ?? 'tool',
              ...(unwrapped['tool_input'] !== undefined ? { input: unwrapped['tool_input'] } : {}),
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
        const isError = unwrapped['is_error'] === true
        const { output, responseObject } = formatToolOutput({
          toolName: name,
          toolInput: unwrapped['tool_input'],
          toolResponse: unwrapped['tool_response'],
          isError,
        })
        return [
          emit(rawType, {
            type: 'tool.call.completed',
            payload: {
              toolCallId,
              name,
              isError,
              result: {
                content: [{ type: 'text', text: output ?? '' }],
                ...(responseObject !== undefined ? { details: responseObject } : {}),
              },
            },
            turnId,
            itemId: toolCallId,
          }),
        ]
      }

      if (rawType === 'Notification') {
        const message = getString(unwrapped, 'message') ?? 'notification'
        const toolCallId = getString(unwrapped, 'tool_use_id')
        if (toolCallId !== undefined) {
          return [
            emit(rawType, {
              type: 'tool.call.delta',
              payload: {
                toolCallId,
                text: message,
                data: { rawHook: unwrapped },
              },
              ...(turnId !== undefined ? { turnId } : {}),
              itemId: toolCallId,
            }),
          ]
        }

        return [
          emit(rawType, {
            type: 'driver.notice',
            payload: {
              message,
              data: { rawHook: unwrapped },
            },
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ]
      }

      if (rawType === 'Stop' || rawType === 'SessionEnd' || rawType === 'SubagentStop') {
        if (turnIdText === undefined || turnId === undefined || completedTurns.has(turnIdText)) {
          return []
        }
        completedTurns.add(turnIdText)
        return [
          emit(rawType, {
            type: 'turn.completed',
            payload: { turnId: turnIdText, status: 'completed' },
            turnId,
          }),
        ]
      }

      if (rawType === 'PreCompact') {
        const trigger = getString(unwrapped, 'trigger')
        const customInstructions = getString(unwrapped, 'custom_instructions')
        const triggerLabel = trigger ? ` (${trigger})` : ''
        return [
          emit(rawType, {
            type: 'diagnostic',
            payload: {
              level: 'info',
              source: 'harness',
              message: `Context compaction${triggerLabel}`,
              data: {
                ...(trigger !== undefined ? { trigger } : {}),
                ...(customInstructions !== undefined ? { customInstructions } : {}),
                ...(compactHookDetails(unwrapped) !== undefined
                  ? { details: compactHookDetails(unwrapped) }
                  : {}),
              },
            },
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ]
      }

      if (rawType === 'SubagentStart') {
        const agentId = getString(unwrapped, 'agent_id')
        const agentType = getString(unwrapped, 'agent_type')
        const label =
          agentType !== undefined || agentId !== undefined
            ? `${agentType ?? 'subagent'}${agentId !== undefined ? ` (${agentId})` : ''}`
            : 'subagent'

        return [
          emit(rawType, {
            type: 'driver.notice',
            payload: {
              message: `Subagent start: ${label}`,
              code: 'subagent_start',
              data: {
                ...(agentId !== undefined ? { agentId } : {}),
                ...(agentType !== undefined ? { agentType } : {}),
                rawHook: unwrapped,
              },
            },
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ]
      }

      if (rawType === 'PermissionRequest') {
        const permissionRequestId = getString(unwrapped, 'permission_request_id')
        const kind = getString(unwrapped, 'kind')
        const defaultDecision = getString(unwrapped, 'default_decision')
        if (
          permissionRequestId === undefined ||
          kind === undefined ||
          unwrapped['subject_display'] === undefined ||
          (defaultDecision !== 'allow' && defaultDecision !== 'deny')
        ) {
          return []
        }
        return [
          emit(rawType, {
            type: 'permission.requested',
            payload: {
              permissionRequestId: permissionRequestId as PermissionRequestId,
              kind,
              subjectDisplay: unwrapped['subject_display'],
              defaultDecision,
              ...(typeof unwrapped['deadline_ms'] === 'number'
                ? { deadlineMs: unwrapped['deadline_ms'] }
                : {}),
            },
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ]
      }

      if (rawType === 'PermissionResolved') {
        const permissionRequestId = getString(unwrapped, 'permission_request_id')
        const decision = getString(unwrapped, 'decision')
        const decidedBy = getString(unwrapped, 'decided_by')
        if (
          permissionRequestId === undefined ||
          (decision !== 'allow' && decision !== 'deny') ||
          (decidedBy !== 'policy' &&
            decidedBy !== 'user' &&
            decidedBy !== 'api' &&
            decidedBy !== 'timeout')
        ) {
          return []
        }
        return [
          emit(rawType, {
            type: 'permission.resolved',
            payload: {
              permissionRequestId: permissionRequestId as PermissionRequestId,
              decision,
              decidedBy,
              ...(typeof unwrapped['message'] === 'string'
                ? { message: unwrapped['message'] }
                : {}),
            },
            ...(turnId !== undefined ? { turnId } : {}),
          }),
        ]
      }

      return []
    },

    normalizeToolCallFailure(failure): InvocationEventEnvelope {
      return sequencer.next(
        invocationId,
        'tool.call.failed',
        {
          toolCallId: failure.toolCallId as ToolCallId,
          name: failure.name,
          message: failure.message,
          ...(failure.code !== undefined ? { code: failure.code } : {}),
          ...(failure.data !== undefined ? { data: failure.data } : {}),
        },
        {
          turnId: asTurnId(failure.turnId),
          itemId: failure.toolCallId,
          driver: { kind: CLAUDE_CODE_TMUX_DRIVER_KIND, rawType: 'driver.failure' },
        }
      )
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

function compactHookDetails(hook: Record<string, unknown>): Record<string, unknown> | undefined {
  const details: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(hook)) {
    if (
      key === 'hook_event_name' ||
      key === 'cp_run_id' ||
      key === 'session_id' ||
      key === 'transcript_path' ||
      key === 'permission_mode' ||
      key === 'cwd' ||
      key === 'trigger' ||
      key === 'custom_instructions'
    ) {
      continue
    }
    details[key] = value
  }
  return Object.keys(details).length > 0 ? details : undefined
}

function formatToolOutput(options: {
  toolName: string
  toolInput: unknown
  toolResponse: unknown
  isError: boolean
}): { output?: string | undefined; responseObject?: Record<string, unknown> | undefined } {
  const { toolName, toolInput, toolResponse, isError } = options
  const toolInputRecord = asRecordOrUndefined(toolInput)
  let toolOutput: string | undefined
  let toolResponseObject: Record<string, unknown> | undefined

  if (typeof toolResponse === 'string') {
    toolOutput = toolResponse
  } else if (Array.isArray(toolResponse)) {
    toolResponseObject = { content: toolResponse }
    toolOutput = extractTextFromContent(toolResponse as MessageContent)
  } else if (toolResponse !== null && typeof toolResponse === 'object') {
    const response = toolResponse as Record<string, unknown>
    toolResponseObject = response
    const stdout = response['stdout']
    const stderr = response['stderr']
    if (typeof stdout === 'string') {
      toolOutput = stdout
    } else if (typeof stderr === 'string') {
      toolOutput = stderr
    }
    const content = response['content']
    if (toolOutput === undefined && Array.isArray(content)) {
      toolOutput = extractTextFromContent(content as MessageContent)
    }
  }

  if (!isError && toolName === 'Write' && toolInputRecord !== undefined) {
    const filePath = getString(toolInputRecord, 'file_path')
    const content = getString(toolInputRecord, 'content')
    if (filePath !== undefined && content !== undefined) {
      const fileName = filePath.split('/').pop() || filePath
      const lineCount = content.split('\n').length
      toolOutput = `Created ${fileName} with ${lineCount} lines`
    }
  }

  if (toolOutput === undefined && toolResponse !== undefined) {
    toolOutput = stringifyToolValue(toolResponse)
  }

  return {
    ...(toolOutput !== undefined ? { output: toolOutput } : {}),
    ...(toolResponseObject !== undefined ? { responseObject: toolResponseObject } : {}),
  }
}

function extractTextFromContent(content: MessageContent): string {
  if (typeof content === 'string') return content
  return content
    .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
    .filter(Boolean)
    .join('\n')
}

function stringifyToolValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function getString(obj: Record<string, unknown>, key: string): string | undefined {
  const value = obj[key]
  return typeof value === 'string' ? value : undefined
}

function asTurnId(value: string): TurnId {
  return value as TurnId
}
