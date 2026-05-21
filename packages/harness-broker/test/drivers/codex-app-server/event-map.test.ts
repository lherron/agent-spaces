import { describe, expect, test } from 'bun:test'
import { mapCodexNotification } from '../../../src/drivers/codex-app-server/event-map'

function note(method: string, params: unknown) {
  return { jsonrpc: '2.0' as const, method, params }
}

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
