import { describe, expect, test } from 'bun:test'
import {
  CODEX_DRIVER_KIND,
  createCodexNotificationMapper,
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

    // Scope-1 regression tripwire (T-06550): a nonzero process exit reached its
    // result boundary — it STAYS tool.call.completed with isError:false, and the
    // raw exit is carried ONLY at the neutral result.exitCode. The exit-type
    // aliasing ternary and the exit-code isError branch are both deleted, so the
    // event type and isError are never derived from the exit code.
    test('item/completed with exitCode non-zero STAYS completed with isError:false and result.exitCode carried', () => {
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
      expect(events[0]?.type).toBe('tool.call.completed')
      expect((events[0]?.payload as { isError: boolean }).isError).toBe(false)
      expect((events[0]?.payload as { result: unknown }).result).toEqual({
        output: '',
        exitCode: 1,
      })
    })

    // Precedence (scope 2a): even when Codex ALSO stamps a non-'completed'
    // status, a defined exitCode is a reached result boundary → completed. The
    // status branch must not re-alias an ordinary nonzero exit (acceptance 1
    // wins). The repo cannot prove whether Codex sets status:'failed' for
    // ordinary exits, so this guard is load-bearing either way.
    test('item/completed with nonzero exitCode AND status="failed" STAYS completed (exitCode boundary wins)', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'commandExecution',
            id: 'cmd_1',
            command: 'false',
            cwd: '/tmp/work',
            aggregatedOutput: 'boom',
            exitCode: 2,
            durationMs: 4,
            status: 'failed',
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.completed')
      expect((events[0]?.payload as { isError: boolean }).isError).toBe(false)
      expect((events[0]?.payload as { result: Record<string, unknown> }).result).toMatchObject({
        exitCode: 2,
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

    // No result boundary (exitCode null) + non-'completed' status → failed, with
    // the contract ToolCallFailedPayload: required message, always-populated
    // machine-readable code (status-derived), and NO isError (that field is a
    // completed-payload concept).
    test('item/completed with status="failed" and NO exitCode emits contract tool.call.failed', () => {
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
      const p = events[0]?.payload as Record<string, unknown>
      expect(p['code']).toBe('codex_failed')
      expect(typeof p['message']).toBe('string')
      expect((p['message'] as string).length).toBeGreaterThan(0)
      expect(p).not.toHaveProperty('isError')
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

    test('item/completed with status="failed" emits contract tool.call.failed', () => {
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
      const p = events[0]?.payload as Record<string, unknown>
      expect(p['code']).toBe('codex_failed')
      expect(typeof p['message']).toBe('string')
      expect(p).not.toHaveProperty('isError')
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

    // Scope 2(b), evidence-locked: the v2 mcpToolCall `error` field is the
    // TRANSPORT/execution channel (McpToolCallError = { message }, the Err side
    // of Result<CallToolResult,String>); the success result type has no isError.
    // A non-null error → contract tool.call.failed with message from the error
    // channel and a machine-readable code. Forensics (result + error) are
    // preserved under data.result.
    test('item/completed with error non-null emits contract tool.call.failed (transport channel)', () => {
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
      const p = events[0]?.payload as Record<string, unknown>
      expect(p['code']).toBe('codex_mcp_error')
      expect(p['message']).toBe('permission denied')
      expect(p).not.toHaveProperty('isError')
      expect((p['data'] as { result?: unknown })?.result).toEqual({
        error: { message: 'permission denied' },
        result: { partial: 'data' },
      })
    })

    test('item/completed with error as a raw string emits tool.call.failed carrying that message', () => {
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
      expect(events[0]?.type).toBe('tool.call.failed')
      const p = events[0]?.payload as Record<string, unknown>
      expect(p['code']).toBe('codex_mcp_error')
      expect(p['message']).toBe('boom')
      expect((p['data'] as { result?: unknown })?.result).toEqual({ error: 'boom' })
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

  describe('notice-shaped server notifications', () => {
    test('deprecationNotice emits a driver.notice with migration details', () => {
      const events = mapCodexNotification(
        note('deprecationNotice', {
          summary: 'The legacy_sandbox config key is deprecated.',
          details: 'Use sandbox_mode instead.',
        })
      )

      expect(events).toEqual([
        {
          type: 'driver.notice',
          payload: {
            message: 'The legacy_sandbox config key is deprecated.',
            code: 'deprecationNotice',
            data: { details: 'Use sandbox_mode instead.' },
          },
          extra: {
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'deprecationNotice' },
          },
        },
      ])
    })

    test('configWarning emits a driver.notice with warning details', () => {
      const events = mapCodexNotification(
        note('configWarning', {
          summary: 'Ignored invalid value for model_reasoning_effort.',
          details: 'Expected low, medium, or high.',
        })
      )

      expect(events).toEqual([
        {
          type: 'driver.notice',
          payload: {
            message: 'Ignored invalid value for model_reasoning_effort.',
            code: 'configWarning',
            data: { details: 'Expected low, medium, or high.' },
          },
          extra: {
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'configWarning' },
          },
        },
      ])
    })

    test('windows/worldWritableWarning emits a driver.notice preserving every structured field', () => {
      const events = mapCodexNotification(
        note('windows/worldWritableWarning', {
          extraCount: 2,
          failedScan: true,
          samplePaths: ['C:\\Temp', 'C:\\Shared'],
        })
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'driver.notice',
        payload: {
          code: 'windows/worldWritableWarning',
          data: {
            extraCount: 2,
            failedScan: true,
            samplePaths: ['C:\\Temp', 'C:\\Shared'],
          },
        },
        extra: {
          driver: { kind: CODEX_DRIVER_KIND, rawType: 'windows/worldWritableWarning' },
        },
      })
      const message = (events[0]?.payload as { message: string }).message
      expect(message).toContain('world-writable')
      expect(message).toContain('C:\\Temp')
      expect(message).toContain('C:\\Shared')
      expect(message).toContain('2')
      expect(message).toMatch(/scan[^.]*fail|fail[^.]*scan/i)
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

  describe('reasoning summary capture (T-06380)', () => {
    test('collapses streamed summary churn into one durable diagnostic at item completion', () => {
      const map = createCodexNotificationMapper()
      const beforeCompletion = [
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'reasoning', id: 'reason_1', summary: [], content: [] },
        }),
        note('item/reasoning/summaryPartAdded', {
          turnId: 'turn_1',
          itemId: 'reason_1',
          summaryIndex: 0,
        }),
        note('item/reasoning/summaryTextDelta', {
          turnId: 'turn_1',
          itemId: 'reason_1',
          summaryIndex: 0,
          delta: '**Planning the inspection**',
        }),
      ].flatMap(map)

      expect(beforeCompletion).toEqual([])

      const events = map(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: ['**Planning the inspection**', 'Checking the package name'],
            content: [],
          },
        })
      )

      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        type: 'diagnostic',
        payload: {
          level: 'debug',
          source: 'driver',
          kind: 'reasoning',
          message: 'Codex reasoning summary captured',
          data: {
            summary: '**Planning the inspection**\n\nChecking the package name',
            truncated: false,
          },
        },
        extra: {
          turnId: 'turn_1',
          itemId: 'reason_1',
          driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
        },
      })
    })

    test('never persists raw reasoning text when no provider summary is present', () => {
      const map = createCodexNotificationMapper()
      expect(
        map(
          note('item/reasoning/textDelta', {
            turnId: 'turn_1',
            itemId: 'reason_1',
            contentIndex: 0,
            delta: 'raw chain of thought',
          })
        )
      ).toEqual([])
      expect(
        map(
          note('item/completed', {
            turnId: 'turn_1',
            item: {
              type: 'reasoning',
              id: 'reason_1',
              summary: [],
              content: ['raw chain of thought'],
            },
          })
        )
      ).toEqual([])
    })

    test('bounds a captured summary by both part count and character count', () => {
      const map = createCodexNotificationMapper()
      const events = map(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'reasoning',
            id: 'reason_1',
            summary: ['x'.repeat(5_000), ...Array.from({ length: 9 }, (_, i) => `part ${i}`)],
          },
        })
      )
      const payload = events[0]?.payload as {
        data: { summary: string; truncated: boolean }
      }
      expect(payload.data.summary).toHaveLength(4_096)
      expect(payload.data.truncated).toBe(true)
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

  describe('turn/diff/updated dedupe (T-06350)', () => {
    // Codex re-emits the whole turn's CUMULATIVE diff on every rate-limit telemetry
    // heartbeat, unchanged. Measured over real captures: 822/822 heartbeat-triggered
    // fires carried a byte-identical diff, so the pane repainted the same card.
    const diffFor = (added: string[]) =>
      [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -0,0 +1 @@',
        ...added.map((l) => `+${l}`),
      ].join('\n')

    const diffNote = (diff: string, turnId = 'turn_1') =>
      note('turn/diff/updated', { threadId: 'thread_1', turnId, diff })
    const heartbeat = () => note('account/rateLimits/updated', { rateLimits: { used: 1 } })
    const diffEvents = (events: ReturnType<typeof mapCodexNotification>) =>
      events.filter((e) => (e.payload as Record<string, unknown>)['kind'] === 'diff')

    test('an unchanged cumulative diff re-sent on heartbeats renders once, not once per beat', () => {
      const map = createCodexNotificationMapper()
      const diff = diffFor(['one'])
      const first = diffEvents(map(diffNote(diff)))
      expect(first).toHaveLength(1)
      // The real firing pattern: heartbeat, then the same diff again, over and over.
      for (let i = 0; i < 5; i++) {
        expect(map(heartbeat())).toEqual([])
        expect(diffEvents(map(diffNote(diff)))).toEqual([])
      }
    })

    test('a diff that actually changed still renders', () => {
      const map = createCodexNotificationMapper()
      expect(diffEvents(map(diffNote(diffFor(['one']))))).toHaveLength(1)
      expect(diffEvents(map(diffNote(diffFor(['one']))))).toHaveLength(0)
      // An edit lands: the cumulative diff grows, so the summary changes.
      expect(diffEvents(map(diffNote(diffFor(['one', 'two']))))).toHaveLength(1)
    })

    test('a new turn re-renders its first diff even if identical to the previous turn', () => {
      const map = createCodexNotificationMapper()
      const diff = diffFor(['one'])
      expect(diffEvents(map(diffNote(diff, 'turn_1')))).toHaveLength(1)
      expect(diffEvents(map(diffNote(diff, 'turn_1')))).toHaveLength(0)
      map(note('turn/started', { turnId: 'turn_1' }))
      expect(diffEvents(map(diffNote(diff, 'turn_1')))).toHaveLength(1)
    })

    test('dedupe is per-invocation, so a fresh mapper never inherits another turn state', () => {
      const diff = diffFor(['one'])
      expect(diffEvents(createCodexNotificationMapper()(diffNote(diff)))).toHaveLength(1)
      expect(diffEvents(createCodexNotificationMapper()(diffNote(diff)))).toHaveLength(1)
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
