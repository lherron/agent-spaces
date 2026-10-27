import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { messageIdFrom, toolCallIdFrom } from '../../ids'
import { type CodexTuiRun, withCodexTui } from './codex-tui-transport-support'

// Native turn/message notifications pushed through the real codex-tui driver
// (FakeCodexRpc), asserted on the broker events they become. Driver rawType
// annotation and the no-model usage shape are pinned by the headless goldens.

const T = 'thread_test'

const agentMessageCompleted = (tui: CodexTuiRun, id: string, text: string) =>
  tui.emit('item/completed', {
    threadId: T,
    turnId: 'turn_1',
    item: { type: 'agentMessage', id, text },
  })

const completeTurn = (tui: CodexTuiRun, turnId = 'turn_1') =>
  tui.emit('turn/completed', { threadId: T, turn: { id: turnId, status: 'completed', items: [] } })

const FLOW = new Set([
  'turn.started',
  'assistant.message.started',
  'assistant.message.delta',
  'assistant.message.completed',
  'tool.call.started',
  'tool.call.completed',
  'turn.completed',
])
const flow = (events: InvocationEventEnvelope[]) => events.filter((event) => FLOW.has(event.type))

describe('codex turn and message flow reaches the broker', () => {
  describe('agentMessage held-latest finality (T-01707)', () => {
    test('multi-message turn emits N-1 intermediate completions and exactly one final completion at turn terminal', async () => {
      await withCodexTui('inv_held_latest_multi', (tui) => {
        tui.startTurn('turn_1')
        agentMessageCompleted(tui, 'msg_1', 'First answer.')
        tui.emit('item/started', {
          threadId: T,
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_1', command: 'pwd' },
        })
        tui.emit('item/completed', {
          threadId: T,
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            aggregatedOutput: '/tmp/work\n',
            exitCode: 0,
          },
        })
        agentMessageCompleted(tui, 'msg_2', 'Final answer.')
        completeTurn(tui)

        expect(tui.ofType('assistant.message.completed').map((event) => event.payload)).toEqual([
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
        expect(flow(tui.since()).map((event) => event.type)).toEqual([
          'turn.started',
          'assistant.message.completed',
          'tool.call.started',
          'tool.call.completed',
          'assistant.message.completed',
          'turn.completed',
        ])
      })
    })

    test('started and delta pass through while the only completion is held, then flushed final at turn terminal', async () => {
      await withCodexTui('inv_held_latest_single', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/started', {
          threadId: T,
          turnId: 'turn_1',
          item: { type: 'agentMessage', id: 'msg_1' },
        })
        tui.emit('item/agentMessage/delta', {
          threadId: T,
          turnId: 'turn_1',
          id: 'msg_1',
          text: 'Hel',
        })
        tui.emit('item/agentMessage/delta', {
          threadId: T,
          turnId: 'turn_1',
          id: 'msg_1',
          text: 'lo',
        })
        agentMessageCompleted(tui, 'msg_1', 'Hello')

        const beforeTerminal = flow(tui.since())
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

        completeTurn(tui)
        const terminal = flow(tui.since()).slice(beforeTerminal.length)
        expect(terminal.map((event) => event.type)).toEqual([
          'assistant.message.completed',
          'turn.completed',
        ])
        expect(terminal[0]?.payload).toEqual({
          messageId: messageIdFrom('msg_1'),
          content: [{ type: 'text', text: 'Hello' }],
          final: true,
        })
      })
    })
  })

  describe('contextCompaction item (T-07726)', () => {
    test('one compaction (started then completed) is one info diagnostic marking the transcript discontinuity', async () => {
      await withCodexTui('inv_context_compaction', (tui) => {
        tui.startTurn('turn_1')
        const item = { type: 'contextCompaction', id: 'compact_1' }
        tui.emit('item/started', { threadId: T, turnId: 'turn_1', item })
        tui.emit('item/completed', { threadId: T, turnId: 'turn_1', item })
        const compactions = tui
          .ofType('diagnostic')
          .filter((event) => (event.payload as { kind?: string }).kind === 'compaction')
        expect(compactions).toHaveLength(1)
        expect(compactions[0]).toMatchObject({
          turnId: 'turn_1',
          payload: {
            level: 'info',
            source: 'driver',
            kind: 'compaction',
            message: 'Codex compacted the thread context',
          },
        })
      })
    })
  })

  describe('minimal fields', () => {
    test('a type+id-only command item starts with no input field and completes with isError:false', async () => {
      await withCodexTui('inv_minimal_command_item', (tui) => {
        tui.startTurn('turn_1')
        const item = { type: 'commandExecution', id: 'cmd_x' }
        tui.emit('item/started', { threadId: T, turnId: 'turn_1', item })
        tui.emit('item/completed', { threadId: T, turnId: 'turn_1', item })
        expect(tui.ofType('tool.call.started').map((event) => event.payload)).toEqual([
          { toolCallId: toolCallIdFrom('cmd_x'), name: 'command' },
        ])
        expect(tui.ofType('tool.call.completed').map((event) => event.payload)).toEqual([
          { toolCallId: toolCallIdFrom('cmd_x'), name: 'command', isError: false },
        ])
      })
    })
  })
})

describe('usage model identity (T-08430)', () => {
  test('usage carries the thread model, and a mid-thread reroute lands on the next usage', async () => {
    await withCodexTui(
      'inv_usage_model_identity',
      (tui) => {
        tui.startTurn('turn_1')
        tui.emit('thread/tokenUsage/updated', {
          threadId: T,
          turnId: 'turn_1',
          usage: { totalTokens: 1 },
        })
        tui.emit('model/rerouted', {
          threadId: T,
          turnId: 'turn_1',
          fromModel: 'gpt-5.6-sol',
          toModel: 'gpt-5.6-codex-mini',
          reason: 'highRiskCyberActivity',
        })
        tui.emit('thread/tokenUsage/updated', {
          threadId: T,
          turnId: 'turn_1',
          usage: { totalTokens: 2 },
        })
        expect(tui.ofType('usage.updated').map((event) => event.payload)).toEqual([
          { usage: { totalTokens: 1 }, model: { id: 'gpt-5.6-sol', source: 'provider-response' } },
          {
            usage: { totalTokens: 2 },
            model: { id: 'gpt-5.6-codex-mini', source: 'provider-response' },
          },
        ])
      },
      { threadModel: 'gpt-5.6-sol' }
    )
  })
})
