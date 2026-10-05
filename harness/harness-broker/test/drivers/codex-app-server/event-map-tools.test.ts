import { describe, expect, test } from 'bun:test'
import { CODEX_DRIVER_KIND } from '../../../src/drivers/codex-app-server/event-map'
import { toolCallIdFrom, turnIdFrom } from '../../ids'
import { codexMapperPerTest, note } from './codex-notifications'

const { map: mapCodexNotification, sequence: mapSequence } = codexMapperPerTest()

describe('mapCodexNotification — tool item projection (T-01554)', () => {
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
        toolCallId: toolCallIdFrom('cmd_1'),
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
        toolCallId: toolCallIdFrom('cmd_1'),
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
        toolCallId: toolCallIdFrom('file_1'),
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
        toolCallId: toolCallIdFrom('file_1'),
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
        toolCallId: toolCallIdFrom('mcp_1'),
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
        toolCallId: toolCallIdFrom('web_1'),
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
        toolCallId: toolCallIdFrom('web_1'),
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
        toolCallId: toolCallIdFrom('img_1'),
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
        toolCallId: toolCallIdFrom('img_1'),
        name: 'image_view',
        result: { path: '/tmp/image.png' },
        isError: false,
      })
    })
  })

  describe('unified_exec terminalInteraction', () => {
    function interaction(params: Record<string, unknown>) {
      return note('item/commandExecution/terminalInteraction', {
        threadId: 'thread_1',
        turnId: 'turn_1',
        itemId: 'cmd_1',
        processId: '4242',
        ...params,
      })
    }

    test('non-empty stdin → tool.call.delta on the OWNING exec call, tagged stream=stdin', () => {
      const events = mapCodexNotification(interaction({ stdin: '\\dt\n' }))
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('tool.call.delta')
      expect(events[0]?.payload).toEqual({
        toolCallId: toolCallIdFrom('cmd_1'),
        text: '\\dt\n',
        data: { stream: 'stdin' },
      })
      expect<string | undefined>(events[0]?.extra?.turnId).toBe('turn_1')
      expect(events[0]?.extra?.itemId).toBe('cmd_1')
    })

    test('itemId is the same toolCallId the exec item opened, so stdin joins that call', () => {
      const events = mapSequence([
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_1', command: 'psql' },
        }),
        interaction({ stdin: '\\dt\n' }),
      ])
      const started = events.find((event) => event.type === 'tool.call.started')
      const delta = events.find((event) => event.type === 'tool.call.delta')
      expect((started?.payload as { toolCallId: string }).toolCallId).toBe(
        (delta?.payload as { toolCallId: string }).toolCallId
      )
    })

    test('empty stdin is a background-PTY poll, not content → no events', () => {
      expect(mapCodexNotification(interaction({ stdin: '' }))).toEqual([])
    })

    test('repeated background polls never accumulate events (pane-flood guard)', () => {
      const polls = Array.from({ length: 25 }, () => interaction({ stdin: '' }))
      expect(mapSequence(polls)).toEqual([])
    })

    test('the method is handled, NOT left to the unknown-notification diagnostic', () => {
      const events = mapSequence([interaction({ stdin: 'y\n' }), interaction({ stdin: '' })])
      expect(events.some((event) => event.type === 'diagnostic')).toBe(false)
    })

    test('missing turnId or itemId is dropped rather than emitting a malformed delta', () => {
      expect(
        mapCodexNotification(
          note('item/commandExecution/terminalInteraction', { itemId: 'cmd_1', stdin: 'y' })
        )
      ).toEqual([])
      expect(
        mapCodexNotification(
          note('item/commandExecution/terminalInteraction', { turnId: 'turn_1', stdin: 'y' })
        )
      ).toEqual([])
    })
  })

  describe('imageGeneration item (T-07726)', () => {
    test('a started generation is a tool call, no longer dropped', () => {
      const events = mapCodexNotification(
        note('item/started', {
          turnId: 'turn_1',
          item: { type: 'imageGeneration', id: 'img_1', status: 'in_progress', result: '' },
        })
      )
      expect(events).toEqual([
        {
          type: 'tool.call.started',
          payload: { toolCallId: toolCallIdFrom('img_1'), name: 'image_generation' },
          extra: {
            turnId: turnIdFrom('turn_1'),
            itemId: 'img_1',
            driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/started' },
          },
        },
      ])
    })

    test('the base64 image NEVER reaches the event; only the artifact path and its size do', () => {
      const base64 = 'iVBORw0KGgo'.repeat(50_000)
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'imageGeneration',
            id: 'img_1',
            status: 'completed',
            revisedPrompt: 'A wide engineering timeline chart.',
            result: base64,
            savedPath: '/tmp/codex/img_1.png',
          },
        })
      )
      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        type: 'tool.call.completed',
        payload: {
          toolCallId: toolCallIdFrom('img_1'),
          name: 'image_generation',
          result: {
            savedPath: '/tmp/codex/img_1.png',
            prompt: 'A wide engineering timeline chart.',
            encodedBytes: base64.length,
          },
          isError: false,
        },
        extra: {
          turnId: turnIdFrom('turn_1'),
          itemId: 'img_1',
          driver: { kind: CODEX_DRIVER_KIND, rawType: 'item/completed' },
        },
      })
      expect(JSON.stringify(events[0])).not.toContain('iVBORw0KGgo')
    })

    test('an oversized revised prompt is clipped, not carried whole', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'imageGeneration',
            id: 'img_1',
            status: 'completed',
            revisedPrompt: 'p'.repeat(2_000),
            result: 'abc',
          },
        })
      )
      const prompt = (events[0]?.payload as { result: { prompt: string } }).result.prompt
      expect(prompt).toHaveLength(501)
      expect(prompt.endsWith('…')).toBe(true)
    })

    test('a generation that terminated without a result is a tool.call.failed', () => {
      const events = mapCodexNotification(
        note('item/completed', {
          turnId: 'turn_1',
          item: {
            type: 'imageGeneration',
            id: 'img_1',
            status: 'failed',
            result: '',
            failure: { reason: 'moderation_blocked' },
          },
        })
      )
      expect(events[0]?.type).toBe('tool.call.failed')
      expect(events[0]?.payload).toMatchObject({
        toolCallId: 'img_1',
        name: 'image_generation',
        code: 'codex_failed',
      })
    })
  })
})
