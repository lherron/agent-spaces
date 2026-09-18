/**
 * muse-cli-tmux log normalizer tests (T-08601).
 *
 * Fixtures use the exact record shapes observed live (muse 1.3.0): an
 * echo-provider turn, a tool-call turn, an Escape interrupt, and a
 * busy-steer inbox record from real operator sessions.
 */
import { describe, expect, test } from 'bun:test'
import { createMuseCliTmuxLogEventNormalizer, parseMuseSessionLine } from './log-events'
import type { MuseSessionRecord } from './native-types'

const now = () => new Date('2026-09-18T12:00:00.000Z')

function normalize(lines: string[]) {
  const normalizer = createMuseCliTmuxLogEventNormalizer({ invocationId: 'inv_test', now })
  return lines.flatMap((line) =>
    parseMuseSessionLine(line).flatMap((record) => normalizer.normalizeRecord(record))
  )
}

function flat(payloadType: string, payload: unknown, sequence = 1, sessionId = 'ses_1') {
  return JSON.stringify({
    schema_version: 1,
    id: `rec-${sequence}`,
    stream: { kind: 'session', id: sessionId },
    sequence,
    recorded_at: 1789742022192673,
    record_type: 'event',
    durability: 'durable',
    causation_id: null,
    payload_type: payloadType,
    payload_schema_version: 1,
    payload,
  })
}

const RUN = 'run_11111111-1111-4111-8111-111111111111'

describe('parseMuseSessionLine', () => {
  test('parses a flat envelope', () => {
    const records = parseMuseSessionLine(
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'hi' },
      })
    )
    expect(records).toHaveLength(1)
    expect(records[0]?.payloadType).toBe('runtime.session')
  })

  test('unwraps retained_frame children', () => {
    const inner = JSON.stringify({
      schema_version: 1,
      id: 'child-1',
      stream: { kind: 'session', id: 'ses_1' },
      sequence: 1,
      payload_type: 'runtime.session.permission_format_declared',
      payload: { schema_version: 1, format: 'profile_v1' },
    })
    const line = JSON.stringify({
      retained_frame: 'session_permission_transaction',
      frame_schema_version: 1,
      outer_log_ordinal: 1,
      transaction_id: 'txn-1',
      children: [{ child_index: 0, record_json: inner }],
    })
    const records = parseMuseSessionLine(line)
    expect(records).toHaveLength(1)
    expect(records[0]?.payloadType).toBe('runtime.session.permission_format_declared')
  })

  test('drops unparseable lines so the tail advances', () => {
    expect(parseMuseSessionLine('not json{')).toEqual([])
    expect(parseMuseSessionLine('{"no":"envelope"}')).toEqual([])
  })
})

describe('turn lifecycle', () => {
  test('intake turn_submit opens the turn with the prompt', () => {
    const events = normalize([
      flat('runtime.command_intake.received', {
        kind: 'command_intake',
        record: {
          kind: 'received',
          command_id: RUN,
          command: { kind: 'turn_submit', prompt: 'say hello spike' },
        },
      }),
    ])
    const started = events.filter((e) => e.type === 'turn.started')
    const user = events.filter((e) => e.type === 'user.message')
    expect(started).toHaveLength(1)
    expect((started[0]?.payload as { prompt?: string }).prompt).toBe('say hello spike')
    expect(started[0]?.turnId).toBe(RUN)
    expect(user).toHaveLength(1)
  })

  test('run started is a fallback when intake is missed', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'hi' },
      }),
    ])
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
  })

  test('a full echo turn normalizes to message + usage + completed', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'hi' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: {
          kind: 'assistant_message_committed',
          message_id: 'msg_1',
          response_id: 'muse-tui-echo',
          text: 'echo: hi',
        },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'model_completed', usage: { input_tokens: 0, output_tokens: 5 } },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'terminal', terminal: 'completed', turn_duration_ms: 341 },
      }),
    ])
    const byType = (t: string) => events.filter((e) => e.type === t)
    expect(byType('turn.started')).toHaveLength(1)
    expect(byType('assistant.message.completed')).toHaveLength(1)
    expect(byType('usage.updated')).toHaveLength(1)
    const completed = byType('turn.completed')
    expect(completed).toHaveLength(1)
    expect((completed[0]?.payload as { finalOutput?: string }).finalOutput).toBe('echo: hi')
    expect((completed[0]?.payload as { producedContent?: boolean }).producedContent).toBe(true)
    expect(byType('continuation.updated')).toHaveLength(1)
  })

  test('duplicate started records open the turn once', () => {
    const events = normalize([
      flat('runtime.command_intake.received', {
        kind: 'command_intake',
        record: {
          kind: 'received',
          command_id: RUN,
          command: { kind: 'turn_submit', prompt: 'hi' },
        },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'hi' },
      }),
    ])
    expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1)
  })
})

describe('tool calls', () => {
  const CALL = 'call_01a0b4779a8772debe0f2887f86a010c'

  test('commit + result batch bracket a tool call', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'find' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: {
          kind: 'assistant_tool_calls_committed',
          message_id: 'msg_2',
          response_id: 'resp_1',
          tool_calls: [{ id: 'fc_1', call_id: CALL, name: 'search', args: '{"pattern":"^"}' }],
        },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: {
          kind: 'tool_result_batch_committed',
          batch_id: 'msg_2',
          results: [{ tool_call_index: 0, tool_call_id: CALL, text: 'found it' }],
        },
      }),
    ])
    const started = events.filter((e) => e.type === 'tool.call.started')
    const completed = events.filter((e) => e.type === 'tool.call.completed')
    expect(started).toHaveLength(1)
    expect((started[0]?.payload as { name?: string }).name).toBe('search')
    expect((started[0]?.payload as { input?: unknown }).input).toEqual({ pattern: '^' })
    expect(completed).toHaveLength(1)
    expect((completed[0]?.payload as { result?: { output?: string } }).result?.output).toBe(
      'found it'
    )
  })

  test('effect terminal without a result still closes the call', () => {
    const events = normalize([
      flat('tool_batch.effect.started', {
        kind: 'tool_batch_effect',
        run_id: RUN,
        record: {
          kind: 'started',
          effect_id: 'eff_1',
          call_id: CALL,
          tool_name: 'search',
        },
      }),
      flat('tool_batch.effect.terminal', {
        kind: 'tool_batch_effect',
        run_id: RUN,
        record: { kind: 'terminal', effect_id: 'eff_1', call_id: CALL, tool_name: 'search' },
      }),
    ])
    const completed = events.filter((e) => e.type === 'tool.call.completed')
    expect(completed).toHaveLength(1)
    expect((completed[0]?.payload as { name?: string }).name).toBe('search')
  })
})

describe('interrupt and steer', () => {
  test('run_retracted interrupts the turn', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'slow' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'run_retracted', reason: 'no_output_interrupt_restore' },
      }),
    ])
    const interrupted = events.filter((e) => e.type === 'turn.interrupted')
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.turnId).toBe(RUN)
  })

  test('Escape order (terminal cancelled, then retraction) mints one terminal', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'slow' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'terminal', terminal: 'cancelled', reason: 'cancelled during model step' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'run_retracted', reason: 'no_output_interrupt_restore' },
      }),
    ])
    expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(0)
    const interrupted = events.filter((e) => e.type === 'turn.interrupted')
    expect(interrupted).toHaveLength(1)
    expect((interrupted[0]?.payload as { reason?: string }).reason).toBe(
      'cancelled during model step'
    )
  })

  test('user_steer inbox items ride the running turn as user messages', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'started', prompt: 'slow' },
      }),
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: {
          kind: 'inbox_item_queued',
          source: { source: 'user_steer' },
          summary: 'steer: hurry',
          body: 'hurry',
          payload: { prompt: 'hurry' },
          disposition: 'steer',
        },
      }),
    ])
    const user = events.filter((e) => e.type === 'user.message')
    // One from the turn open, one from the steer.
    expect(user).toHaveLength(2)
    expect((user[1]?.payload as { content?: string }).content).toBe('hurry')
    expect(user[1]?.turnId).toBe(RUN)
  })

  test('non-steer inbox items are ignored', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: { kind: 'inbox_item_queued', source: { source: 'background' }, body: 'x' },
      }),
    ])
    expect(events).toHaveLength(0)
  })
})

describe('unknown vocabulary', () => {
  test('unknown payload types warn once and the tail continues', () => {
    const record: MuseSessionRecord = {
      sequence: 1,
      payloadType: 'runtime.something_new',
      payload: {},
    }
    const normalizer = createMuseCliTmuxLogEventNormalizer({ invocationId: 'inv_test', now })
    const first = normalizer.normalizeRecord(record)
    const second = normalizer.normalizeRecord(record)
    expect(first.filter((e) => e.type === 'diagnostic')).toHaveLength(1)
    expect(second).toHaveLength(0)
  })

  test('unknown run event kinds warn once', () => {
    const events = normalize([
      flat('runtime.session', { kind: 'run', run_id: RUN, event: { kind: 'future_kind' } }),
      flat('runtime.session', { kind: 'run', run_id: RUN, event: { kind: 'future_kind' } }),
    ])
    expect(events.filter((e) => e.type === 'diagnostic')).toHaveLength(1)
  })

  test('approval questions surface as diagnostics, never permission requests', () => {
    const events = normalize([
      flat('runtime.session', {
        kind: 'run',
        run_id: RUN,
        event: {
          kind: 'user_input_prompt_requested',
          prompt_id: 'prompt_1',
          tool_name: 'request_user_input',
        },
      }),
    ])
    expect(events.filter((e) => e.type === 'permission.requested')).toHaveLength(0)
    expect(events.filter((e) => e.type === 'diagnostic')).toHaveLength(1)
  })
})
