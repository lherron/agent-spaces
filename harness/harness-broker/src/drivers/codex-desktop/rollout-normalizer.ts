import type {
  EventProvenance,
  InputId,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { CapturedRecord, NormalizeOutcome } from '../../capture/capture-gate'
import {
  asCodexRecord,
  classifyCodexRolloutLine,
  codexContentText,
  codexResponseItemOf,
  codexTurnContextModel,
  parseCodexRolloutLine,
} from '../codex-rollout/native'
import { codexNativeToolIdentity } from '../codex-tool-identity'
import type { DriverContext } from '../driver'
import { getString } from '../hook-json'
import { CODEX_DESKTOP_DRIVER_KIND } from './spec'

type HeldAssistant = {
  messageId: MessageId
  content: string
  turnId: TurnId
  provenance?: EventProvenance | undefined
}

type NativeOrchestration = {
  callId: ToolCallId
  turnId: TurnId
}

/** A rollout UserMessage carrying a client id, offered to delivery for ownership. */
export interface ObservedUserMessage {
  clientId: string | undefined
  byteOffset: unknown
  turnId: TurnId
  turnStarted: boolean
  publish: boolean
}

export interface RolloutNormalizerDeps {
  emit: DriverContext['emit']
  threadId(): string
  /** True when the message is the broker's own delivery; records its execution. */
  claimOwnUserMessage(message: ObservedUserMessage): boolean
}

export interface RolloutNormalizer {
  /** Map one captured rollout line; `publish: false` only rebuilds dedupe state. */
  normalize(captured: CapturedRecord, publish?: boolean): NormalizeOutcome
  reset(): void
  lastNativeActivity(): string | undefined
}

export function turnIdOf(payload: Record<string, unknown>): TurnId | undefined {
  return getString(payload, 'turn_id') as TurnId | undefined
}

/** Normalize desktop rollout JSONL into broker events, deduping replayed native ids. */
export function createRolloutNormalizer(deps: RolloutNormalizerDeps): RolloutNormalizer {
  let lastNativeActivity: string | undefined
  let currentTurnId: TurnId | undefined
  let heldAssistant: HeldAssistant | undefined
  let normalizedEventCount = 0
  const seenItems = new Set<string>()
  const seenUsers = new Set<string>()
  const seenTurnStarts = new Set<string>()
  const seenTurnTerminals = new Set<string>()
  const attributedTurns = new Set<string>()
  const contentTurns = new Set<string>()
  const seenToolStarts = new Set<string>()
  const seenToolTerminals = new Set<string>()
  const nativeOrchestrations = new Map<string, NativeOrchestration>()
  /**
   * Model named by each turn's `turn_context` row (T-08430). Codex's
   * `token_count` rows carry no model, so usage borrows the identity its turn
   * opened with; `lastTurnModel` covers a usage row whose turn id is unknown,
   * which can only be the turn currently in flight.
   */
  const turnModels = new Map<string, string>()
  let lastTurnModel: string | undefined

  function emit(
    type: Parameters<DriverContext['emit']>[0],
    payload: Parameters<DriverContext['emit']>[1],
    extra: Parameters<DriverContext['emit']>[2]
  ): void {
    normalizedEventCount += 1
    deps.emit(type as never, payload as never, extra)
  }

  function reset(): void {
    currentTurnId = undefined
    heldAssistant = undefined
    normalizedEventCount = 0
    seenItems.clear()
    seenUsers.clear()
    seenTurnStarts.clear()
    seenTurnTerminals.clear()
    attributedTurns.clear()
    contentTurns.clear()
    seenToolStarts.clear()
    seenToolTerminals.clear()
    nativeOrchestrations.clear()
  }

  function flushAssistant(captured: CapturedRecord, final: boolean, publish: boolean): void {
    const held = heldAssistant
    if (held === undefined) return
    heldAssistant = undefined
    contentTurns.add(held.turnId)
    if (!publish) return
    emit(
      'assistant.message.completed',
      { messageId: held.messageId, content: [{ type: 'text', text: held.content }], final },
      {
        turnId: held.turnId,
        itemId: held.messageId,
        driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: captured.record.nativeType },
        provenance: held.provenance ?? captured.provenance(),
      }
    )
  }

  function itemBelongsToThread(payload: Record<string, unknown>): boolean {
    const threadId = getString(payload, 'thread_id')
    return threadId === undefined || threadId === deps.threadId()
  }

  /** `custom_tool_call` / `_output`: the code-mode exec orchestration bracket. */
  function normalizeOrchestration(
    captured: CapturedRecord,
    responseItem: NonNullable<ReturnType<typeof codexResponseItemOf>>,
    publish: boolean
  ): NormalizeOutcome {
    const metadata = asCodexRecord(
      responseItem.payload['internal_chat_message_metadata_passthrough']
    )
    const turnId = getString(metadata ?? {}, 'turn_id') as TurnId | undefined
    const callId = getString(responseItem.payload, 'call_id') as ToolCallId | undefined
    if (turnId === undefined || callId === undefined) {
      return {
        disposition: 'ignored-known',
        detail: `${responseItem.itemType} without stable turn/call identity`,
      }
    }
    lastNativeActivity = captured.record.observedAt

    if (responseItem.itemType === 'custom_tool_call_output') {
      const orchestration = nativeOrchestrations.get(callId)
      if (orchestration === undefined || orchestration.turnId !== turnId) {
        return {
          disposition: 'ignored-known',
          detail: 'custom_tool_call_output without matching exec orchestration',
        }
      }
      if (seenToolTerminals.has(callId)) {
        return { disposition: 'duplicate', detail: 'response_item:custom_tool_call_output' }
      }
      seenToolTerminals.add(callId)
      contentTurns.add(turnId)
      const codeModeOutput = responseItem.payload['output']
      const outputText =
        typeof codeModeOutput === 'string' ? codeModeOutput : codexContentText(codeModeOutput)
      if (publish) {
        emit(
          'tool.call.completed',
          {
            toolCallId: callId,
            name: 'exec/orchestration',
            ...(codeModeOutput !== undefined
              ? {
                  result: {
                    output: `[exec/orchestration output]${outputText.length > 0 ? `\n${outputText}` : ''}`,
                    codeModeOutput,
                  },
                }
              : {}),
          },
          stampExtra(captured, turnId, undefined, callId, true)
        )
      }
      return { disposition: 'normalized', detail: 'response_item:custom_tool_call_output' }
    }

    // The response item is a code-mode orchestration boundary, not evidence
    // that any one child CommandExecution started at this timestamp.
    if (getString(responseItem.payload, 'name') !== 'exec') {
      return {
        disposition: 'ignored-known',
        detail: 'response_item:custom_tool_call without proven completion pairing',
      }
    }
    if (seenToolStarts.has(callId)) {
      return { disposition: 'duplicate', detail: 'response_item:custom_tool_call' }
    }
    seenToolStarts.add(callId)
    nativeOrchestrations.set(callId, { callId, turnId })
    contentTurns.add(turnId)
    if (publish) {
      emit(
        'tool.call.started',
        {
          toolCallId: callId,
          name: 'exec/orchestration',
          ...(responseItem.payload['input'] !== undefined
            ? { input: { codeMode: responseItem.payload['input'] } }
            : {}),
        },
        stampExtra(captured, turnId, undefined, callId, true)
      )
    }
    return { disposition: 'normalized', detail: 'response_item:custom_tool_call' }
  }

  function normalizeItemCompleted(
    captured: CapturedRecord,
    item: Record<string, unknown>,
    turnId: TurnId,
    publish: boolean
  ): void {
    const itemType = getString(item, 'type')
    const itemId = (getString(item, 'id') ??
      `${itemType ?? 'item'}:${captured.record.rawRecordId}`) as string
    if (itemType === 'UserMessage' && !seenUsers.has(itemId)) {
      seenUsers.add(itemId)
      const content = codexContentText(item['content'])
      const clientId = getString(item, 'client_id')
      const own = deps.claimOwnUserMessage({
        clientId,
        byteOffset: captured.record.sourceCursor['byteOffset'],
        turnId,
        turnStarted: seenTurnStarts.has(turnId),
        publish,
      })
      const inputId = own ? (clientId as InputId) : undefined
      if (publish) {
        emit(
          'user.message',
          { content, role: 'user', turnId, ...(inputId !== undefined ? { inputId } : {}) },
          stampExtra(captured, turnId, inputId, itemId)
        )
        emit(
          'turn.attributed',
          {
            turnId,
            ownership: own ? 'own' : 'foreign',
            origin: own ? 'broker' : 'human',
            ...(inputId !== undefined ? { inputId } : {}),
          },
          stampExtra(captured, turnId, inputId)
        )
      }
      attributedTurns.add(turnId)
    } else if (itemType === 'AgentMessage' && !seenItems.has(itemId)) {
      seenItems.add(itemId)
      const content = codexContentText(item['content'])
      if (content.length === 0) return
      flushAssistant(captured, false, publish)
      if (getString(item, 'phase') !== 'commentary') {
        heldAssistant = {
          messageId: itemId as MessageId,
          content,
          turnId,
          provenance: captured.provenance(),
        }
        return
      }
      contentTurns.add(turnId)
      if (publish) {
        emit(
          'assistant.message.completed',
          {
            messageId: itemId as MessageId,
            content: [{ type: 'text', text: content }],
            final: false,
          },
          stampExtra(captured, turnId, undefined, itemId)
        )
      }
    } else if (isRecordedTool(itemType) && !seenItems.has(itemId)) {
      seenItems.add(itemId)
      contentTurns.add(turnId)
      const identity = codexNativeToolIdentity(itemType ?? '', item, toolName(itemType, item)) ?? {
        itemId,
        toolCallId: itemId as ToolCallId,
        name: toolName(itemType, item),
      }
      if (publish) {
        emit(
          'tool.call.completed',
          {
            toolCallId: identity.toolCallId,
            name: identity.name,
            result: recordedToolResult(itemType, item),
            ...(item['is_error'] === true ? { isError: true } : {}),
          },
          stampExtra(captured, turnId, undefined, identity.itemId, true)
        )
      }
    }
  }

  function normalizeTaskComplete(
    captured: CapturedRecord,
    payload: Record<string, unknown>,
    publish: boolean
  ): void {
    const completedTurn = turnIdOf(payload) ?? currentTurnId
    if (completedTurn === undefined || seenTurnTerminals.has(completedTurn)) return
    const lastAgentMessage = getString(payload, 'last_agent_message')
    if (
      heldAssistant === undefined &&
      lastAgentMessage !== undefined &&
      lastAgentMessage.length > 0
    ) {
      heldAssistant = {
        messageId: `agent:${completedTurn}:terminal` as MessageId,
        content: lastAgentMessage,
        turnId: completedTurn,
        provenance: captured.provenance(),
      }
    }
    flushAssistant(captured, true, publish)
    if (!attributedTurns.has(completedTurn) && publish) {
      emit(
        'turn.attributed',
        { turnId: completedTurn, ownership: 'unknown', origin: 'unknown' },
        stampExtra(captured, completedTurn)
      )
    }
    attributedTurns.add(completedTurn)
    seenTurnTerminals.add(completedTurn)
    if (publish) {
      emit(
        'turn.completed',
        {
          turnId: completedTurn,
          status: 'completed',
          ...(lastAgentMessage !== undefined ? { finalOutput: lastAgentMessage } : {}),
          producedContent: contentTurns.has(completedTurn),
        },
        stampExtra(captured, completedTurn)
      )
    }
    if (currentTurnId === completedTurn) currentTurnId = undefined
  }

  // The branches deliberately mirror Codex's persisted EventMsg vocabulary so
  // every native family remains auditable in one normalization switch.
  function normalize(captured: CapturedRecord, publish = true): NormalizeOutcome {
    const line = Buffer.from(captured.record.rawBytes).toString('utf8')
    const responseItem = codexResponseItemOf(line)
    if (
      responseItem?.itemType === 'custom_tool_call' ||
      responseItem?.itemType === 'custom_tool_call_output'
    ) {
      return normalizeOrchestration(captured, responseItem, publish)
    }
    const turnContextModel = codexTurnContextModel(line)
    if (turnContextModel !== undefined) {
      lastTurnModel = turnContextModel.model
      if (turnContextModel.turnId !== undefined) {
        turnModels.set(turnContextModel.turnId, turnContextModel.model)
      }
    }
    const classified = classifyCodexRolloutLine(line)
    if ('outcome' in classified) return classified.outcome
    const { payload, payloadType, item } = classified
    if (!itemBelongsToThread(payload)) {
      return { disposition: 'ignored-known', detail: 'different desktop thread' }
    }
    lastNativeActivity = captured.record.observedAt
    const turnId = turnIdOf(payload) ?? currentTurnId
    // State changes count as normalization even during reconstruction; this is
    // deliberately a cheap monotonic proxy, not a public event counter.
    const before = normalizedEventCount

    if (payloadType === 'task_started') {
      const startedTurn = turnIdOf(payload)
      if (startedTurn !== undefined) {
        currentTurnId = startedTurn
        if (!seenTurnStarts.has(startedTurn)) {
          seenTurnStarts.add(startedTurn)
          if (publish) {
            emit(
              'turn.started',
              { turnId: startedTurn, source: 'observed', sessionId: deps.threadId() },
              stampExtra(captured, startedTurn)
            )
          }
        }
      }
    } else if (payloadType === 'item_completed' && item !== undefined && turnId !== undefined) {
      normalizeItemCompleted(captured, item, turnId, publish)
    } else if (payloadType === 'agent_message' && turnId !== undefined) {
      const content = getString(payload, 'message')
      const itemId = getString(payload, 'id') ?? `agent:${turnId}:${captured.record.rawRecordId}`
      if (content !== undefined && !seenItems.has(itemId)) {
        seenItems.add(itemId)
        flushAssistant(captured, false, publish)
        heldAssistant = {
          messageId: itemId as MessageId,
          content,
          turnId,
          provenance: captured.provenance(),
        }
      }
    } else if (payloadType === 'token_count') {
      const usage = payload['info']
      if (usage !== undefined && publish) {
        const model = (turnId !== undefined ? turnModels.get(turnId) : undefined) ?? lastTurnModel
        emit(
          'usage.updated',
          {
            usage,
            ...(model !== undefined ? { model: { id: model, source: 'provider-response' } } : {}),
          },
          stampExtra(captured, turnId)
        )
      }
    } else if (payloadType === 'task_complete') {
      normalizeTaskComplete(captured, payload, publish)
    } else if (payloadType === 'turn_aborted') {
      const abortedTurn = turnIdOf(payload) ?? currentTurnId
      if (abortedTurn !== undefined && !seenTurnTerminals.has(abortedTurn)) {
        flushAssistant(captured, false, publish)
        seenTurnTerminals.add(abortedTurn)
        if (publish) {
          emit(
            'turn.interrupted',
            { turnId: abortedTurn, status: 'interrupted', reason: getString(payload, 'reason') },
            stampExtra(captured, abortedTurn)
          )
        }
        if (currentTurnId === abortedTurn) currentTurnId = undefined
      }
    }

    return normalizedEventCount > before
      ? { disposition: 'normalized', detail: `event_msg:${payloadType}` }
      : { disposition: 'state-only', detail: `event_msg:${payloadType}` }
  }

  return { normalize, reset, lastNativeActivity: () => lastNativeActivity }
}

function stampExtra(
  captured: CapturedRecord,
  turnId?: TurnId,
  inputId?: InputId,
  itemId?: string,
  preserveSourceTime = false
) {
  return {
    ...(turnId !== undefined ? { turnId } : {}),
    ...(inputId !== undefined ? { inputId } : {}),
    ...(itemId !== undefined ? { itemId } : {}),
    ...(preserveSourceTime ? { sourceTime: sourceTimeOf(captured) } : {}),
    driver: { kind: CODEX_DESKTOP_DRIVER_KIND, rawType: captured.record.nativeType },
    provenance: captured.provenance(),
  }
}

function sourceTimeOf(captured: CapturedRecord): string | undefined {
  const entry = parseCodexRolloutLine(Buffer.from(captured.record.rawBytes).toString('utf8'))
  const timestamp = getString(entry ?? {}, 'timestamp')
  return timestamp !== undefined && !Number.isNaN(Date.parse(timestamp)) ? timestamp : undefined
}

const RECORDED_TOOL_ITEM_TYPES = new Set([
  'CommandExecution',
  'DynamicToolCall',
  'CollabAgentToolCall',
  'WebSearch',
  'ImageView',
  'Extension',
  'ImageGeneration',
  'FileChange',
  'McpToolCall',
  'FunctionCallOutput',
])

function isRecordedTool(itemType: string | undefined): boolean {
  return RECORDED_TOOL_ITEM_TYPES.has(itemType ?? '')
}

function toolName(itemType: string | undefined, item: Record<string, unknown>): string {
  return getString(item, 'tool') ?? getString(item, 'name') ?? itemType ?? 'recorded-tool'
}

function recordedToolResult(itemType: string | undefined, item: Record<string, unknown>): unknown {
  if (itemType === 'CommandExecution') {
    return {
      status: item['status'],
      stdout: item['stdout'],
      stderr: item['stderr'],
      output: item['aggregated_output'],
      exitCode: item['exit_code'],
      duration: item['duration'],
    }
  }
  return item
}
