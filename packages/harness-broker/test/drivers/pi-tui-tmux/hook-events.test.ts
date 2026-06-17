import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope, InvocationEventType } from 'spaces-harness-broker-protocol'

type PiTuiTmuxHookEventNormalizer = {
  normalizeHook: (hook: Record<string, unknown>) => InvocationEventEnvelope[]
}

const invocationId = 'inv_pi_tui_tmux_1'
const eventTypes = (events: InvocationEventEnvelope[]): InvocationEventType[] =>
  events.map((event) => event.type)

const createNormalizer = async (): Promise<PiTuiTmuxHookEventNormalizer> => {
  const target = (await import('../../../src/drivers/pi-tui-tmux/hook-events')) as {
    createPiTuiTmuxHookEventNormalizer: (options: {
      invocationId: string
      now: () => Date
      allocateTurnId?: (() => string) | undefined
    }) => PiTuiTmuxHookEventNormalizer
  }
  let counter = 0
  return target.createPiTuiTmuxHookEventNormalizer({
    invocationId,
    now: () => new Date('2026-06-17T04:30:00.000Z'),
    allocateTurnId: () => {
      counter += 1
      return `turn_pi_${counter}`
    },
  })
}

describe('pi-tui-tmux hook event normalization', () => {
  test('normalizes Pi lifecycle, message, tool, and continuation events without leaking native event types', async () => {
    const normalizer = await createNormalizer()
    const events = [
      ...normalizer.normalizeHook({
        eventName: 'session_start',
        payload: { sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session.jsonl' },
      }),
      ...normalizer.normalizeHook({ eventName: 'agent_start', payload: {} }),
      ...normalizer.normalizeHook({
        eventName: 'message_end',
        payload: {
          messageId: 'msg_intermediate',
          message: { role: 'assistant', content: 'I will inspect the directory.' },
        },
      }),
      ...normalizer.normalizeHook({
        eventName: 'tool_execution_start',
        payload: {
          toolCallId: 'tool_1',
          toolName: 'bash',
          args: { command: "printf 'PI_TUI_TMUX_OK'" },
        },
      }),
      ...normalizer.normalizeHook({
        eventName: 'tool_execution_end',
        payload: {
          toolCallId: 'tool_1',
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'PI_TUI_TMUX_OK' }] },
          isError: false,
        },
      }),
      ...normalizer.normalizeHook({
        eventName: 'message_end',
        payload: {
          messageId: 'msg_final',
          message: { role: 'assistant', content: [{ type: 'text', text: 'PI_TUI_TMUX_OK' }] },
        },
      }),
      ...normalizer.normalizeHook({ eventName: 'agent_end', payload: {} }),
    ]

    expect(eventTypes(events)).toEqual([
      'continuation.updated',
      'turn.started',
      'tool.call.started',
      'tool.call.completed',
      'assistant.message.completed',
      'assistant.message.completed',
      'turn.completed',
    ])
    expect(events[0]).toMatchObject({
      type: 'continuation.updated',
      driver: { kind: 'pi-tui-tmux', rawType: 'session_start' },
      payload: { provider: 'openai', kind: 'session', key: 'pi-session-1' },
    })
    expect(events[2]).toMatchObject({
      type: 'tool.call.started',
      turnId: 'turn_pi_1',
      driver: { kind: 'pi-tui-tmux', rawType: 'tool_execution_start' },
      payload: {
        toolCallId: 'tool_1',
        name: 'bash',
        input: { command: "printf 'PI_TUI_TMUX_OK'" },
      },
    })
    expect(events[4]).toMatchObject({
      type: 'assistant.message.completed',
      driver: { kind: 'pi-tui-tmux', rawType: 'message_end' },
      payload: { messageId: 'msg_intermediate', final: false },
    })
    expect(events[5]).toMatchObject({
      type: 'assistant.message.completed',
      driver: { kind: 'pi-tui-tmux', rawType: 'message_end' },
      payload: { messageId: 'msg_final', final: true },
    })
    expect(new Set(eventTypes(events))).not.toContain('agent_start' as InvocationEventType)
    expect(new Set(eventTypes(events))).not.toContain('tool_execution_start' as InvocationEventType)
  })

  test('normalizePiHookEnvelope merges the driver active turn id from the envelope', async () => {
    const target = (await import('../../../src/drivers/pi-tui-tmux/hook-events')) as {
      normalizePiHookEnvelope: (
        envelope: {
          invocationId: string
          generation: number
          callbackSocket: string
          turnId?: string | undefined
          hookData: unknown
        },
        options?: { now?: () => Date }
      ) => InvocationEventEnvelope[]
    }
    const events = target.normalizePiHookEnvelope(
      {
        invocationId,
        generation: 1,
        callbackSocket: '/tmp/pi-hooks.sock',
        turnId: 'turn_from_driver',
        hookData: { eventName: 'agent_start', payload: {} },
      },
      { now: () => new Date('2026-06-17T04:30:00.000Z') }
    )

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'turn.started',
      turnId: 'turn_from_driver',
      payload: { turnId: 'turn_from_driver', source: 'hook-observed' },
      driver: { kind: 'pi-tui-tmux', rawType: 'agent_start' },
    })
  })
})
