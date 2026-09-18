import type {
  InvocationEventEnvelope,
  InvocationEventFor,
  InvocationEventType,
  InvocationId,
  MessageId,
  ToolCallId,
  TurnId,
} from 'spaces-harness-broker-protocol'
import { createInvocationEventSequencer } from '../../events'
import {
  MUSE_CLI_TMUX_DRIVER_KIND,
  MUSE_KNOWN_PAYLOAD_TYPES,
  MUSE_KNOWN_RUN_EVENT_KINDS,
  type MuseSessionRecord,
  type MuseToolCallEntry,
  type MuseToolResultEntry,
} from './native-types'

export { MUSE_CLI_TMUX_DRIVER_KIND }

export type MuseCliTmuxLogEventNormalizer = {
  normalizeRecord: (record: MuseSessionRecord) => InvocationEventEnvelope[]
  /**
   * Session teardown the log never records: the TUI exits without a quit
   * marker, so the driver synthesizes continuation.cleared off harness
   * exit through the SAME sequencer (ordering with polled turn events
   * preserved).
   */
  sessionEnded: (reason: string) => InvocationEventEnvelope[]
}

export type MuseCliTmuxLogEventNormalizerOptions = {
  invocationId: string
  now: () => Date
}

type MappedLogEvent = {
  [K in InvocationEventType]: InvocationEventFor<K> & {
    turnId?: TurnId | undefined
    itemId?: string | undefined
  }
}[InvocationEventType]

type ActiveTool = {
  toolCallId: string
  name: string
}

type TurnState = {
  opened: boolean
  closed: boolean
  prompt?: string | undefined
  assistantTexts: string[]
  toolsByCallId: Map<string, ActiveTool>
  completedCallIds: Set<string>
  toolActivity: boolean
  usageTexts: string[]
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return {}
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Unwrap one `session.jsonl` line into session records. Most lines are flat
 * event envelopes; the leading permission frame wraps children whose
 * `record_json` carries the envelope. Unparseable lines yield [] — the tail
 * advances past them.
 */
export function parseMuseSessionLine(line: string): MuseSessionRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return []
  }
  const root = asRecord(parsed)
  if (root['retained_frame'] !== undefined) {
    const out: MuseSessionRecord[] = []
    const children = root['children']
    if (Array.isArray(children)) {
      for (const child of children) {
        const recordJson = getString(asRecord(child), 'record_json')
        if (recordJson === undefined) continue
        try {
          const rec = asRecord(JSON.parse(recordJson))
          const record = toSessionRecord(rec)
          if (record !== undefined) out.push(record)
        } catch {
          // Skip the unreadable child; the tail advances past it.
        }
      }
    }
    return out
  }
  const record = toSessionRecord(root)
  return record === undefined ? [] : [record]
}

function toSessionRecord(envelope: Record<string, unknown>): MuseSessionRecord | undefined {
  const payloadType = getString(envelope, 'payload_type')
  if (payloadType === undefined) return undefined
  const sequence = envelope['sequence']
  const recordedAt = envelope['recorded_at']
  const stream = asRecord(envelope['stream'])
  const sessionId = getString(stream, 'id')
  return {
    sequence: typeof sequence === 'number' ? sequence : -1,
    ...(typeof recordedAt === 'number' ? { recordedAt } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    payloadType,
    payload: envelope['payload'],
  }
}

function toolCallEntries(event: Record<string, unknown>): MuseToolCallEntry[] {
  const calls = event['tool_calls']
  if (!Array.isArray(calls)) return []
  const out: MuseToolCallEntry[] = []
  for (const call of calls) {
    const rec = asRecord(call)
    const id = getString(rec, 'id')
    const callId = getString(rec, 'call_id')
    const name = getString(rec, 'name')
    const args = getString(rec, 'args')
    if (id === undefined || callId === undefined || name === undefined || args === undefined) {
      continue
    }
    out.push({ id, callId, name, args })
  }
  return out
}

function toolResultEntries(event: Record<string, unknown>): MuseToolResultEntry[] {
  const results = event['results']
  if (!Array.isArray(results)) return []
  const out: MuseToolResultEntry[] = []
  for (const result of results) {
    const rec = asRecord(result)
    const toolCallId = getString(rec, 'tool_call_id')
    const index = rec['tool_call_index']
    const text = getString(rec, 'text')
    if (toolCallId === undefined || typeof index !== 'number' || text === undefined) continue
    out.push({ toolCallIndex: index, toolCallId, text })
  }
  return out
}

export function createMuseCliTmuxLogEventNormalizer(
  options: MuseCliTmuxLogEventNormalizerOptions
): MuseCliTmuxLogEventNormalizer {
  const invocationId = options.invocationId as InvocationId
  const sequencer = createInvocationEventSequencer({ now: options.now })
  const turns = new Map<string, TurnState>()
  const warnedKinds = new Set<string>()

  const emit = (rawType: string, event: MappedLogEvent): InvocationEventEnvelope => {
    return sequencer.nextEvent(invocationId, event, {
      ...(event.turnId !== undefined ? { turnId: event.turnId } : {}),
      ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
      driver: { kind: MUSE_CLI_TMUX_DRIVER_KIND, rawType },
    })
  }

  const warnOnce = (rawType: string, message: string, raw: unknown): InvocationEventEnvelope[] => {
    if (warnedKinds.has(rawType)) return []
    warnedKinds.add(rawType)
    return [
      emit(rawType, {
        type: 'diagnostic',
        payload: { level: 'warn', source: 'driver', message, data: { raw } },
      }),
    ]
  }

  function turnState(runId: string): TurnState {
    let state = turns.get(runId)
    if (state === undefined) {
      state = {
        opened: false,
        closed: false,
        assistantTexts: [],
        toolsByCallId: new Map(),
        completedCallIds: new Set(),
        toolActivity: false,
        usageTexts: [],
      }
      turns.set(runId, state)
    }
    return state
  }

  function openTurn(
    runId: string,
    sessionId: string | undefined,
    prompt: string | undefined
  ): InvocationEventEnvelope[] {
    const state = turnState(runId)
    if (state.opened) return []
    state.opened = true
    if (prompt !== undefined) state.prompt = prompt
    const turnId = runId as TurnId
    const events: InvocationEventEnvelope[] = [
      emit('turn.open', {
        type: 'turn.started',
        payload: {
          turnId,
          source: 'observed',
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(prompt !== undefined ? { prompt } : {}),
        },
        turnId,
      }),
    ]
    if (prompt !== undefined && prompt.length > 0) {
      events.push(
        emit('turn.open', {
          type: 'user.message',
          payload: { content: prompt, turnId },
          turnId,
        })
      )
    }
    return events
  }

  // Turn-submit intake: the authoritative user-message boundary. The
  // command_id IS the run_id the following run events carry.
  function normalizeIntake(record: MuseSessionRecord): InvocationEventEnvelope[] {
    const payload = asRecord(record.payload)
    const entry = asRecord(payload['record'])
    const command = asRecord(entry['command'])
    if (command['kind'] !== 'turn_submit') return []
    const commandId = getString(entry, 'command_id')
    const prompt = getString(command, 'prompt')
    if (commandId === undefined) return []
    return openTurn(commandId, record.sessionId, prompt)
  }

  // Tool execution spans. `assistant_tool_calls_committed` below is the
  // authoritative intent (name + args); effect records only fill liveness.
  function normalizeEffect(record: MuseSessionRecord): InvocationEventEnvelope[] {
    const payload = asRecord(record.payload)
    const entry = asRecord(payload['record'])
    const runId = getString(payload, 'run_id')
    const callId = getString(entry, 'call_id')
    const toolName = getString(entry, 'tool_name')
    if (runId === undefined || callId === undefined) return []
    const state = turnState(runId)
    if (record.payloadType === 'tool_batch.effect.started') {
      if (toolName !== undefined && !state.toolsByCallId.has(callId)) {
        state.toolsByCallId.set(callId, { toolCallId: callId, name: toolName })
      }
      return []
    }
    if (state.completedCallIds.has(callId)) return []
    const tool = state.toolsByCallId.get(callId)
    state.completedCallIds.add(callId)
    state.toolActivity = true
    return [
      emit(record.payloadType, {
        type: 'tool.call.completed',
        payload: {
          toolCallId: callId as ToolCallId,
          name: tool?.name ?? toolName ?? 'tool',
          isError: false,
          result: {
            output: '',
            content: [{ type: 'text', text: '' }],
            details: { effectTerminalWithoutResult: true },
          },
        },
        turnId: runId as TurnId,
        itemId: callId,
      }),
    ]
  }

  return {
    sessionEnded(reason: string): InvocationEventEnvelope[] {
      return [
        emit('SessionEnd', {
          type: 'continuation.cleared',
          payload: { reason },
        }),
      ]
    },
    normalizeRecord(record: MuseSessionRecord): InvocationEventEnvelope[] {
      const payload = asRecord(record.payload)
      if (!MUSE_KNOWN_PAYLOAD_TYPES.has(record.payloadType)) {
        return warnOnce(
          record.payloadType,
          `muse-cli-tmux: unknown session payload_type "${record.payloadType}"; tail continues`,
          { sequence: record.sequence, payloadType: record.payloadType }
        )
      }
      if (record.payloadType === 'runtime.command_intake.received') {
        return normalizeIntake(record)
      }
      if (
        record.payloadType === 'tool_batch.effect.started' ||
        record.payloadType === 'tool_batch.effect.terminal'
      ) {
        return normalizeEffect(record)
      }
      if (record.payloadType !== 'runtime.session') return []
      const kind = getString(payload, 'kind')
      if (kind === 'task' || kind === 'agent_tree_initialized') return []
      if (kind !== 'run') {
        return warnOnce(
          `runtime.session:${String(kind)}`,
          `muse-cli-tmux: unknown runtime.session kind "${String(kind)}"; tail continues`,
          { sequence: record.sequence }
        )
      }
      const event = asRecord(payload['event'])
      const eventKind = getString(event, 'kind')
      const runId = getString(payload, 'run_id')
      if (eventKind === undefined || runId === undefined) return []
      if (!MUSE_KNOWN_RUN_EVENT_KINDS.has(eventKind)) {
        return warnOnce(
          `run:${eventKind}`,
          `muse-cli-tmux: unknown run event kind "${eventKind}"; tail continues`,
          { sequence: record.sequence, runId }
        )
      }
      const turnId = runId as TurnId
      const rawType = `run:${eventKind}`

      switch (eventKind) {
        case 'started': {
          return openTurn(runId, record.sessionId, getString(event, 'prompt'))
        }
        case 'assistant_message_committed': {
          const text = getString(event, 'text') ?? ''
          const messageId = getString(event, 'message_id')
          if (text.length === 0 || messageId === undefined) return []
          const state = turnState(runId)
          state.assistantTexts.push(text)
          return [
            emit(rawType, {
              type: 'assistant.message.completed',
              payload: {
                messageId: messageId as MessageId,
                content: [{ type: 'text', text }],
                final: true,
              },
              turnId,
              itemId: messageId,
            }),
          ]
        }
        case 'assistant_tool_calls_committed': {
          const entries = toolCallEntries(event)
          if (entries.length === 0) return []
          const state = turnState(runId)
          state.toolActivity = true
          return entries.map((entry) => {
            state.toolsByCallId.set(entry.callId, {
              toolCallId: entry.callId,
              name: entry.name,
            })
            let input: unknown = entry.args
            try {
              input = JSON.parse(entry.args)
            } catch {
              // Keep the raw args string when it is not JSON.
            }
            return emit(rawType, {
              type: 'tool.call.started',
              payload: {
                toolCallId: entry.callId as ToolCallId,
                name: entry.name,
                input,
              },
              turnId,
              itemId: entry.callId,
            })
          })
        }
        case 'tool_result_batch_committed': {
          const entries = toolResultEntries(event)
          if (entries.length === 0) return []
          const state = turnState(runId)
          state.toolActivity = true
          return entries.map((entry) => {
            const tool = state.toolsByCallId.get(entry.toolCallId)
            state.completedCallIds.add(entry.toolCallId)
            return emit(rawType, {
              type: 'tool.call.completed',
              payload: {
                toolCallId: entry.toolCallId as ToolCallId,
                name: tool?.name ?? 'tool',
                isError: false,
                result: {
                  output: entry.text,
                  content: [{ type: 'text', text: entry.text }],
                },
              },
              turnId,
              itemId: entry.toolCallId,
            })
          })
        }
        case 'model_completed':
        case 'goal_usage_attribution': {
          const usage =
            eventKind === 'model_completed'
              ? event['usage']
              : (asRecord(event['record'])['quantity'] ?? event)
          const state = turnState(runId)
          state.usageTexts.push(eventKind)
          return [
            emit(rawType, {
              type: 'usage.updated',
              payload: { usage: usage ?? {} },
              turnId,
            }),
          ]
        }
        case 'inbox_item_queued': {
          const source = asRecord(event['source'])
          if (source['source'] !== 'user_steer') return []
          const body =
            getString(asRecord(event['payload']), 'prompt') ?? getString(event, 'body') ?? ''
          if (body.length === 0) return []
          // A steer absorbed while a turn runs: no turn of its own, so it
          // rides the running turn's id as transcript landing evidence.
          return [
            emit(rawType, {
              type: 'user.message',
              payload: { content: body, turnId },
              turnId,
            }),
          ]
        }
        case 'terminal': {
          const state = turnState(runId)
          // An Escape retraction lands as terminal{terminal:"cancelled"} (seq N)
          // followed by run_retracted (seq N+1, live ghostmux proof): the
          // terminal record alone decides the bracket, and the retraction
          // after a closed turn is a no-op so one turn never mints two
          // terminals.
          if (state.closed) return []
          state.closed = true
          const finalOutput = state.assistantTexts.at(-1) ?? ''
          const outcome = getString(event, 'terminal') ?? 'completed'
          const reason = getString(event, 'reason')
          const events: InvocationEventEnvelope[] =
            outcome === 'completed'
              ? [
                  emit(rawType, {
                    type: 'turn.completed',
                    payload: {
                      turnId,
                      status: 'completed',
                      finalOutput,
                      producedContent: finalOutput.length > 0 || state.toolActivity,
                    },
                    turnId,
                  }),
                ]
              : [
                  emit(rawType, {
                    type: 'turn.interrupted',
                    payload: {
                      turnId,
                      status: 'interrupted',
                      ...(finalOutput.length > 0 ? { finalOutput } : {}),
                      ...(reason !== undefined ? { reason } : {}),
                    },
                    turnId,
                  }),
                ]
          if (record.sessionId !== undefined) {
            events.push(
              emit(rawType, {
                type: 'continuation.updated',
                payload: { provider: 'muse', kind: 'session', key: record.sessionId },
              })
            )
          }
          return events
        }
        case 'run_retracted': {
          const state = turnState(runId)
          // Retraction after the terminal record already closed the bracket
          // (the observed order) is recorded, not re-emitted.
          if (state.closed) return []
          state.closed = true
          const finalOutput = state.assistantTexts.at(-1) ?? ''
          const reason = getString(event, 'reason')
          return [
            emit(rawType, {
              type: 'turn.interrupted',
              payload: {
                turnId,
                status: 'interrupted',
                ...(finalOutput.length > 0 ? { finalOutput } : {}),
                ...(reason !== undefined ? { reason } : {}),
              },
              turnId,
            }),
          ]
        }
        case 'user_input_prompt_requested':
        case 'user_input_prompt_settled': {
          // Approval/question flow. v1 surfaces these as diagnostics (see
          // MUSE_CLI_TMUX_AUTHORITY: `permission` stays broker); emitting
          // `permission.requested` without broker-owned lifecycle would be a
          // stronger claim than the tail can back.
          const promptId = getString(event, 'prompt_id') ?? getString(event, 'tool_call_id')
          return [
            emit(rawType, {
              type: 'diagnostic',
              payload: {
                level: 'info',
                source: 'driver',
                message: `muse-cli-tmux: user input ${eventKind} (approval/question flow)`,
                data: {
                  ...(promptId !== undefined ? { promptId } : {}),
                  toolName: getString(event, 'tool_name'),
                },
              },
              turnId,
            }),
          ]
        }
        default: {
          // Reviewed-but-unmapped run kinds (reasoning summaries, reminders,
          // compaction, diagnostics): the tail advances past them silently.
          return []
        }
      }
    },
  }
}
