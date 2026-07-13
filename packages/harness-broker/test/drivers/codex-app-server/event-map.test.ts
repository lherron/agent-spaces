import { describe, expect, test } from 'bun:test'
import {
  CODEX_DRIVER_KIND,
  mapCodexNotification,
} from '../../../src/drivers/codex-app-server/event-map'

function note(method: string, params: unknown) {
  return { jsonrpc: '2.0' as const, method, params }
}

function mapSequence(notes: Array<ReturnType<typeof note>>) {
  return notes.flatMap((notification) => mapCodexNotification(notification))
}

function agentMessageCompleted(id: string, text: string, extra: Record<string, unknown> = {}) {
  return note('item/completed', {
    turnId: 'turn_1',
    item: {
      type: 'agentMessage',
      id,
      text,
      ...extra,
    },
  })
}

describe('mapCodexNotification — tool item projection (T-01554)', () => {
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
          messageId: 'msg_1',
          content: [{ type: 'text', text: 'First answer.' }],
          final: false,
        },
        {
          messageId: 'msg_2',
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
        messageId: 'msg_1',
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
        { messageId: 'msg_1' },
        { messageId: 'msg_1', text: 'Hel' },
        { messageId: 'msg_1', text: 'lo' },
      ])

      const terminalEvents = mapCodexNotification(
        note('turn/completed', { turnId: 'turn_1', status: 'completed' })
      )

      expect(terminalEvents.map((event) => event.type)).toEqual([
        'assistant.message.completed',
        'turn.completed',
      ])
      expect(terminalEvents[0]?.payload).toEqual({
        messageId: 'msg_1',
        content: [{ type: 'text', text: 'Hello' }],
        final: true,
      })
    })
  })

  describe('commandExecution', () => {
    test('item/started projects { command, cwd } into payload.input', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            cwd: '/tmp/work',
          },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.started')
      expect(events[0]?.payload).toEqual({
        toolCallId: 'cmd_1',
        name: 'command',
        input: { command: 'pwd', cwd: '/tmp/work' },
      })
    })

    test('item/completed with exitCode:0 projects normalized { output, exitCode } and isError:false', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            cwd: '/tmp/work',
            aggregatedOutput: '/tmp/work\n',
            exitCode: 0,
            durationMs: 12,
          },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.completed')
      expect(events[0]?.payload).toEqual({
        toolCallId: 'cmd_1',
        name: 'command',
        result: { output: '/tmp/work\n', exitCode: 0 },
        isError: false,
        durationMs: 12,
      })
    })

    test('item/completed with exitCode non-zero emits tool.call.failed and isError:true', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'false',
            cwd: '/tmp/work',
            aggregatedOutput: '',
            exitCode: 1,
            durationMs: 4,
          },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.failed')
      expect((events[0]?.payload as { isError: boolean }).isError).toBe(true)
      expect((events[0]?.payload as { result: unknown }).result).toEqual({
        output: '',
        exitCode: 1,
      })
    })

    test('item/completed with exitCode:null does NOT imply error', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            cwd: '/tmp/work',
            aggregatedOutput: '/tmp/work\n',
            exitCode: null,
            durationMs: null,
          },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.completed')
      const payload = events[0]?.payload as {
        result: unknown
        isError: boolean
        durationMs?: number
      }
      expect(payload.isError).toBe(false)
      expect(payload.result).toEqual({ output: '/tmp/work\n' })
      expect(payload.durationMs).toBeUndefined()
    })

    test('item/completed with null aggregatedOutput omits output from result', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'pwd',
            cwd: '/tmp/work',
            aggregatedOutput: null,
            exitCode: 0,
            durationMs: 0,
          },
        })
      )
      const payload = events[0]?.payload as { result: Record<string, unknown> }
      expect(payload.result).toEqual({ exitCode: 0 })
    })

    test('item/completed with status="failed" emits tool.call.failed even if exitCode is null', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'sleep',
            cwd: '/tmp/work',
            aggregatedOutput: null,
            exitCode: null,
            durationMs: null,
            status: 'failed',
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.failed')
      expect((events[0]?.payload as { isError: boolean }).isError).toBe(true)
    })
  })

  describe('fileChange', () => {
    test('item/started projects { changes } into payload.input', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: {
            type: 'fileChange',
            id: 'file_1',
            changes: [{ path: 'src/a.ts', kind: 'modify' }],
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.started')
      expect(events[0]?.payload).toEqual({
        toolCallId: 'file_1',
        name: 'file_change',
        input: { changes: [{ path: 'src/a.ts', kind: 'modify' }] },
      })
    })

    test('item/completed projects changes and isError:false when status absent', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'fileChange',
            id: 'file_1',
            changes: [{ path: 'src/a.ts', kind: 'modify' }],
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.completed')
      expect(events[0]?.payload).toEqual({
        toolCallId: 'file_1',
        name: 'file_change',
        result: { changes: [{ path: 'src/a.ts', kind: 'modify' }] },
        isError: false,
      })
    })

    test('item/completed with status="failed" emits tool.call.failed', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'fileChange',
            id: 'file_1',
            changes: [],
            status: 'failed',
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.failed')
      expect((events[0]?.payload as { isError: boolean }).isError).toBe(true)
    })
  })

  describe('mcpToolCall', () => {
    test('item/started projects { server, tool, arguments } into payload.input', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 'fs',
            tool: 'read',
            arguments: { path: '/etc/hosts' },
          },
        })
      )
      expect(events[0]?.payload).toEqual({
        toolCallId: 'mcp_1',
        name: 'mcp_tool',
        input: { server: 'fs', tool: 'read', arguments: { path: '/etc/hosts' } },
      })
    })

    test('item/completed with error:null is SUCCESS (regression — generic check would false-fail)', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 'fs',
            tool: 'read',
            arguments: { path: '/etc/hosts' },
            result: { content: 'localhost' },
            error: null,
            durationMs: 8,
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.completed')
      const p = events[0]?.payload as { isError: boolean; result: unknown; durationMs: number }
      expect(p.isError).toBe(false)
      expect(p.result).toEqual({ content: 'localhost' })
      expect(p.durationMs).toBe(8)
    })

    test('item/completed with error non-null emits tool.call.failed and preserves both error + result', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 'fs',
            tool: 'read',
            arguments: { path: '/etc/hosts' },
            result: { partial: 'data' },
            error: { message: 'permission denied' },
            durationMs: 3,
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.failed')
      const p = events[0]?.payload as { isError: boolean; result: Record<string, unknown> }
      expect(p.isError).toBe(true)
      expect(p.result).toEqual({
        error: { message: 'permission denied' },
        result: { partial: 'data' },
      })
    })

    test('item/completed with error non-null and result null preserves only error', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'mcpToolCall',
            id: 'mcp_1',
            server: 'fs',
            tool: 'read',
            arguments: {},
            result: null,
            error: 'boom',
            durationMs: null,
          },
        })
      )
      const p = events[0]?.payload as { result: unknown }
      expect(p.result).toEqual({ error: 'boom' })
    })
  })

  describe('webSearch', () => {
    test('item/started projects { query } into payload.input', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'webSearch', id: 'web_1', query: 'codex' },
        })
      )
      expect(events[0]?.payload).toEqual({
        toolCallId: 'web_1',
        name: 'web_search',
        input: { query: 'codex' },
      })
    })

    test('item/completed projects { query } into payload.result with isError:false', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: { type: 'webSearch', id: 'web_1', query: 'codex' },
        })
      )
      expect(events[0]?.type).toBe('tool.call.completed')
      expect(events[0]?.payload).toEqual({
        toolCallId: 'web_1',
        name: 'web_search',
        result: { query: 'codex' },
        isError: false,
      })
    })
  })

  describe('imageView', () => {
    test('item/started projects { path } into payload.input', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'imageView', id: 'img_1', path: '/tmp/image.png' },
        })
      )
      expect(events[0]?.payload).toEqual({
        toolCallId: 'img_1',
        name: 'image_view',
        input: { path: '/tmp/image.png' },
      })
    })

    test('item/completed projects { path } into payload.result', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: { type: 'imageView', id: 'img_1', path: '/tmp/image.png' },
        })
      )
      expect(events[0]?.payload).toEqual({
        toolCallId: 'img_1',
        name: 'image_view',
        result: { path: '/tmp/image.png' },
        isError: false,
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

  describe('unknown native notification (H6)', () => {
    test('unknown method → trace diagnostic, never leaks native type as normalized type', () => {
      const events = mapCodexNotification(note('thread/somethingNew', { foo: 1 }))
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('diagnostic')
      expect(events[0]?.payload).toEqual({
        level: 'debug',
        message: 'Unhandled Codex notification: thread/somethingNew',
        source: 'driver',
      })
      expect(events[0]?.extra?.driver).toEqual({
        kind: CODEX_DRIVER_KIND,
        rawType: 'thread/somethingNew',
      })
    })

    test.each([
      'account/rateLimits/updated',
      'thread/status/changed',
      'remoteControl/status/changed',
      'mcpServer/startupStatus/updated',
    ])('known-noise method %s is dropped (no event)', (method) => {
      expect(mapCodexNotification(note(method, { foo: 1 }))).toEqual([])
    })
  })

  describe('turn/plan/updated (T-06325)', () => {
    test('projects a plan diagnostic carrying structured steps for the renderer', () => {
      const events = mapCodexNotification(
        note('turn/plan/updated', {
          explanation: null,
          plan: [
            { step: 'Add failing tests', status: 'inProgress' },
            { step: 'Implement', status: 'pending' },
          ],
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('diagnostic')
      const payload = events[0]?.payload as Record<string, unknown>
      expect(payload['kind']).toBe('plan')
      expect(payload['data']).toEqual({
        steps: [
          { step: 'Add failing tests', status: 'inProgress' },
          { step: 'Implement', status: 'pending' },
        ],
      })
      expect(events[0]?.extra?.driver?.rawType).toBe('turn/plan/updated')
    })

    test('empty plan yields no event', () => {
      expect(mapCodexNotification(note('turn/plan/updated', { plan: [] }))).toEqual([])
    })
  })

  describe('turn/diff/updated (T-06325)', () => {
    test('summarizes a unified diff into compact per-file add/remove counts', () => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        'index 000..111 100644',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -1,2 +1,3 @@',
        ' context',
        '-old line',
        '+new line',
        '+extra line',
        'diff --git a/src/b.ts b/src/b.ts',
        '--- a/src/b.ts',
        '+++ b/src/b.ts',
        '@@ -1 +1 @@',
        '-removed',
      ].join('\n')
      const events = mapCodexNotification(note('turn/diff/updated', { diff }))
      expect(events).toHaveLength(1)
      const payload = events[0]?.payload as Record<string, unknown>
      expect(payload['kind']).toBe('diff')
      expect(payload['data']).toEqual({
        files: [
          { path: 'src/a.ts', added: 2, removed: 1 },
          { path: 'src/b.ts', added: 0, removed: 1 },
        ],
        totalAdded: 2,
        totalRemoved: 2,
        truncated: 0,
      })
    })

    test('empty diff yields no event', () => {
      expect(mapCodexNotification(note('turn/diff/updated', { diff: '   ' }))).toEqual([])
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
        toolCallId: 'cmd_x',
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
        toolCallId: 'cmd_x',
        name: 'command',
        isError: false,
      })
    })
  })
})
