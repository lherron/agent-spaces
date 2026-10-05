import { describe, expect, test } from 'bun:test'
import {
  CODEX_DRIVER_KIND,
  createCodexNotificationMapper,
} from '../../../src/drivers/codex-app-server/event-map'
import { messageIdFrom, toolCallIdFrom, turnIdFrom } from '../../ids'
import { agentMessageCompleted, codexMapperPerTest, note } from './codex-notifications'

const { map: mapCodexNotification, sequence: mapSequence } = codexMapperPerTest()

describe('mapCodexNotification — turn and message flow', () => {
  describe('agentMessage held-latest finality (T-01707)', () => {
    test('multi-message turn emits N-1 intermediate completions and exactly one final completion at turn terminal', () => {
      const events = mapSequence([
        note('turn/started', { turnId: 'turn_1' }),
        agentMessageCompleted('msg_1', 'First answer.'),
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_1', command: 'pwd' },
        }),
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            aggregatedOutput: '/tmp/work\n',
            exitCode: 0,
          },
        }),
        agentMessageCompleted('msg_2', 'Final answer.'),
        note('turn/completed', { turnId: 'turn_1', status: 'completed' }),
      ])

      const assistantCompleted = events.filter(
        (event) => event.type === 'assistant.message.completed'
      )
      expect(assistantCompleted).toHaveLength(2)
      expect(assistantCompleted.map((event) => event.payload)).toEqual([
        {
          messageId: messageIdFrom('msg_1'),
          content: [{ type: 'text', text: 'First answer.' }],
          final: false,
        },
        {
          messageId: messageIdFrom('msg_2'),
          content: [{ type: 'text', text: 'Final answer.' }],
          final: true,
        },
      ])
      expect(events.map((event) => event.type)).toEqual([
        'turn.started',
        'assistant.message.completed',
        'tool.call.started',
        'tool.call.completed',
        'assistant.message.completed',
        'turn.completed',
      ])
    })

    test('single-message turn emits no intermediate completion and flushes the only message as final at turn terminal', () => {
      const beforeTerminal = mapSequence([
        note('turn/started', { turnId: 'turn_1' }),
        agentMessageCompleted('msg_1', 'Only answer.'),
      ])
      expect(beforeTerminal.map((event) => event.type)).toEqual(['turn.started'])

      const terminalEvents = mapCodexNotification(
        note('turn/completed', { turnId: 'turn_1', status: 'completed' })
      )
      expect(terminalEvents.map((event) => event.type)).toEqual([
        'assistant.message.completed',
        'turn.completed',
      ])
      expect(terminalEvents[0]?.payload).toEqual({
        messageId: messageIdFrom('msg_1'),
        content: [{ type: 'text', text: 'Only answer.' }],
        final: true,
      })
    })

    test('assistant started and delta events are preserved while completed finality is held until turn terminal', () => {
      const beforeTerminal = mapSequence([
        note('turn/started', { turnId: 'turn_1' }),
        note('item/started', { turnId: 'turn_1', item: { type: 'agentMessage', id: 'msg_1' } }),
        note('item/agentMessage/delta', { turnId: 'turn_1', id: 'msg_1', text: 'Hel' }),
        note('item/agentMessage/delta', { turnId: 'turn_1', id: 'msg_1', text: 'lo' }),
        agentMessageCompleted('msg_1', 'Hello'),
      ])
      expect(beforeTerminal.map((event) => event.type)).toEqual([
        'turn.started',
        'assistant.message.started',
        'assistant.message.delta',
        'assistant.message.delta',
      ])
      expect(beforeTerminal.slice(1).map((event) => event.payload)).toEqual([
        { messageId: messageIdFrom('msg_1') },
        { messageId: messageIdFrom('msg_1'), text: 'Hel' },
        { messageId: messageIdFrom('msg_1'), text: 'lo' },
      ])

      const terminalEvents = mapCodexNotification(
        note('turn/completed', { turnId: turnIdFrom('turn_1'), status: 'completed' })
      )

      expect(terminalEvents.map((event) => event.type)).toEqual([
        'assistant.message.completed',
        'turn.completed',
      ])
      expect(terminalEvents[0]?.payload).toEqual({
        messageId: messageIdFrom('msg_1'),
        content: [{ type: 'text', text: 'Hello' }],
        final: true,
      })
    })
  })

  describe('driver annotation (H6)', () => {
    test('every mapped event carries extra.driver={kind,rawType:method}', () => {
      const cases: Array<[string, unknown]> = [
        ['turn/started', { turnId: 'turn_1' }],
        ['thread/tokenUsage/updated', { usage: { totalTokens: 1 } }],
        ['item/started', { turnId: 'turn_1', item: { type: 'agentMessage', id: 'msg_1' } }],
        ['item/agentMessage/delta', { turnId: 'turn_1', id: 'msg_1', text: 'hi' }],
        [
          'item/completed',
          { turnId: 'turn_1', item: { type: 'commandExecution', id: 'cmd_1', exitCode: 0 } },
        ],
        ['turn/completed', { turnId: 'turn_1', status: 'completed' }],
      ]
      for (const [method, params] of cases) {
        const events = mapCodexNotification(note(method, params))
        expect(events.length).toBeGreaterThan(0)
        for (const event of events) {
          expect(event.extra?.driver).toEqual({ kind: CODEX_DRIVER_KIND, rawType: method })
        }
      }
    })

    test('turn/completed failed → turn.failed and interrupted → turn.interrupted', () => {
      const failed = mapCodexNotification(
        note('turn/completed', { turnId: 'turn_1', status: 'failed', finalOutput: 'boom' })
      )
      expect(failed[0]?.type).toBe('turn.failed')
      expect(failed[0]?.extra?.driver).toEqual({
        kind: CODEX_DRIVER_KIND,
        rawType: 'turn/completed',
      })

      const interrupted = mapCodexNotification(
        note('turn/completed', { turnId: 'turn_1', status: 'interrupted' })
      )
      expect(interrupted[0]?.type).toBe('turn.interrupted')
    })
  })

  describe('contextCompaction item (T-07726)', () => {
    test('a completed compaction surfaces the transcript discontinuity as an info diagnostic', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: { type: 'contextCompaction', id: 'compact_1' },
        })
      )
      expect(events).toEqual([
        {
          type: 'diagnostic',
          payload: {
            level: 'info',
            source: 'driver',
            kind: 'compaction',
            message: 'Codex compacted the thread context',
          },
          extra: {
            turnId: turnIdFrom('turn_1'),
            itemId: 'compact_1',
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
          },
        },
      ])
    })

    test('the started half stays silent so one compaction is one event', () => {
      expect(
        mapCodexNotification(
          note('item/started', {
            turnId: 'turn_1',
            item: { type: 'contextCompaction', id: 'compact_1' },
          })
        )
      ).toEqual([])
    })
  })

  describe('minimal fields', () => {
    test('item/started with only type+id emits stable shape with no input field', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_x' },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.payload).toEqual({
        toolCallId: toolCallIdFrom('cmd_x'),
        name: 'command',
      })
    })

    test('item/completed with only type+id emits stable shape with isError:false', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_x' },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.completed')
      expect(events[0]?.payload).toEqual({
        toolCallId: toolCallIdFrom('cmd_x'),
        name: 'command',
        isError: false,
      })
    })
  })
})

describe('usage model identity (T-08430)', () => {
  test('usage carries the model the driver resolved for the thread', () => {
    const map = createCodexNotificationMapper({
      modelIdentity: () => ({ id: 'gpt-5.6-sol', source: 'provider-response' }),
    })
    const events = map(note('thread/tokenUsage/updated', { usage: { totalTokens: 7 } }))
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toEqual({
      usage: { totalTokens: 7 },
      model: { id: 'gpt-5.6-sol', source: 'provider-response' },
    })
  })

  test('identity is read per event, so a mid-thread reroute lands on the next usage', () => {
    let identity = { id: 'gpt-5.6-sol', source: 'provider-response' as const }
    const map = createCodexNotificationMapper({ modelIdentity: () => identity })
    const before = map(note('thread/tokenUsage/updated', { usage: { totalTokens: 1 } }))
    identity = { id: 'gpt-5.6-codex-mini', source: 'provider-response' }
    const after = map(note('thread/tokenUsage/updated', { usage: { totalTokens: 2 } }))

    expect((before[0]?.payload as Record<string, unknown>)['model']).toMatchObject({
      id: 'gpt-5.6-sol',
    })
    expect((after[0]?.payload as Record<string, unknown>)['model']).toMatchObject({
      id: 'gpt-5.6-codex-mini',
    })
  })

  test('a mapper with no identity source omits the field rather than guessing', () => {
    const map = createCodexNotificationMapper()
    const events = map(note('thread/tokenUsage/updated', { usage: { totalTokens: 7 } }))
    expect(events[0]?.payload).toEqual({ usage: { totalTokens: 7 } })
  })
})
