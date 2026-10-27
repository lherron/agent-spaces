import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { toolCallIdFrom, turnIdFrom } from '../../ids'
import { type CodexTuiRun, withCodexTui } from './codex-tui-transport-support'

// The rest drive native items through the real codex-tui driver (FakeCodexRpc)
// and assert the broker tool events. Happy-path projections for every tool kind
// are pinned by the headless tool-calls golden.

const T = 'thread_test'

const completeItem = (tui: CodexTuiRun, item: Record<string, unknown>) =>
  tui.emit('item/completed', { threadId: T, turnId: 'turn_1', item })

/** The one tool event the item produced (started/completed/failed/delta). */
const toolEvents = (events: InvocationEventEnvelope[]) =>
  events.filter((event) => event.type.startsWith('tool.call.'))

describe('codex tool items reach the broker as tool.call events', () => {
  describe('commandExecution completion', () => {
    // Scope-1 regression tripwire (T-06550): a nonzero process exit reached its
    // result boundary — it STAYS tool.call.completed with isError:false, and the
    // raw exit is carried ONLY at the neutral result.exitCode. Precedence (scope
    // 2a): even when Codex ALSO stamps status:'failed', a defined exitCode wins.
    // Only no result boundary (exitCode null) + non-'completed' status fails,
    // with the contract ToolCallFailedPayload (message, status-derived code, no
    // isError).
    test.each([
      {
        row: 'nonzero exitCode stays completed with result.exitCode',
        item: { aggregatedOutput: '', exitCode: 1, durationMs: 4 },
        type: 'tool.call.completed',
        payload: {
          toolCallId: toolCallIdFrom('cmd_1'),
          name: 'command',
          result: { output: '', exitCode: 1 },
          isError: false,
          durationMs: 4,
        },
      },
      {
        row: 'nonzero exitCode AND status failed stays completed (exitCode boundary wins)',
        item: { aggregatedOutput: 'boom', exitCode: 2, durationMs: 4, status: 'failed' },
        type: 'tool.call.completed',
        payload: {
          toolCallId: toolCallIdFrom('cmd_1'),
          name: 'command',
          result: { output: 'boom', exitCode: 2 },
          isError: false,
          durationMs: 4,
        },
      },
      {
        row: 'exitCode null does not imply error and carries no durationMs',
        item: { aggregatedOutput: '/tmp/work\n', exitCode: null, durationMs: null },
        type: 'tool.call.completed',
        payload: {
          toolCallId: toolCallIdFrom('cmd_1'),
          name: 'command',
          result: { output: '/tmp/work\n' },
          isError: false,
        },
      },
      {
        row: 'null aggregatedOutput omits output from result',
        item: { aggregatedOutput: null, exitCode: 0, durationMs: 0 },
        type: 'tool.call.completed',
        payload: {
          toolCallId: toolCallIdFrom('cmd_1'),
          name: 'command',
          result: { exitCode: 0 },
          isError: false,
          durationMs: 0,
        },
      },
    ])('commandExecution completion: $row', async ({ item, type, payload }) => {
      await withCodexTui('inv_command_completion', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'commandExecution',
          id: 'cmd_1',
          command: 'false',
          cwd: '/tmp/work',
          ...item,
        })
        expect(toolEvents(tui.since()).map((event) => [event.type, event.payload])).toEqual([
          [type, payload],
        ])
      })
    })

    test('commandExecution completion: status failed with no exitCode is a contract tool.call.failed', async () => {
      await withCodexTui('inv_command_failed', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'commandExecution',
          id: 'cmd_1',
          command: 'sleep',
          cwd: '/tmp/work',
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
          status: 'failed',
        })
        const events = toolEvents(tui.since())
        expect(events.map((event) => event.type)).toEqual(['tool.call.failed'])
        const p = events[0]?.payload as Record<string, unknown>
        expect(p['code']).toBe('codex_failed')
        expect(typeof p['message']).toBe('string')
        expect((p['message'] as string).length).toBeGreaterThan(0)
        expect(p).not.toHaveProperty('isError')
      })
    })
  })

  test('a fileChange with status failed is a contract tool.call.failed', async () => {
    await withCodexTui('inv_file_change_failed', (tui) => {
      tui.startTurn('turn_1')
      completeItem(tui, { type: 'fileChange', id: 'file_1', changes: [], status: 'failed' })
      const events = toolEvents(tui.since())
      expect(events.map((event) => event.type)).toEqual(['tool.call.failed'])
      const p = events[0]?.payload as Record<string, unknown>
      expect(p['code']).toBe('codex_failed')
      expect(typeof p['message']).toBe('string')
      expect(p).not.toHaveProperty('isError')
    })
  })

  // Scope 2(b), evidence-locked: the v2 mcpToolCall `error` field is the
  // TRANSPORT/execution channel (McpToolCallError = { message }, the Err side
  // of Result<CallToolResult,String>); the success result type has no isError.
  // A non-null error → contract tool.call.failed with message from the error
  // channel and a machine-readable code. Forensics (result + error) are
  // preserved under data.result.
  test.each([
    {
      row: 'an error object',
      item: { result: { partial: 'data' }, error: { message: 'permission denied' }, durationMs: 3 },
      message: 'permission denied',
      forensics: { error: { message: 'permission denied' }, result: { partial: 'data' } },
    },
    {
      row: 'a raw string error',
      item: { result: null, error: 'boom', durationMs: null },
      message: 'boom',
      forensics: { error: 'boom' },
    },
  ])(
    'an mcpToolCall completed with $row is a contract tool.call.failed carrying its message',
    async ({ item, message, forensics }) => {
      await withCodexTui('inv_mcp_error', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'mcpToolCall',
          id: 'mcp_1',
          server: 'fs',
          tool: 'read',
          arguments: { path: '/etc/hosts' },
          ...item,
        })
        const events = toolEvents(tui.since())
        expect(events.map((event) => event.type)).toEqual(['tool.call.failed'])
        const p = events[0]?.payload as Record<string, unknown>
        expect(p['code']).toBe('codex_mcp_error')
        expect(p['message']).toBe(message)
        expect(p).not.toHaveProperty('isError')
        expect((p['data'] as { result?: unknown })?.result).toEqual(forensics)
      })
    }
  )

  describe('unified_exec terminalInteraction', () => {
    const interaction = (tui: CodexTuiRun, params: Record<string, unknown>) =>
      tui.emit('item/commandExecution/terminalInteraction', {
        threadId: T,
        turnId: 'turn_1',
        itemId: 'cmd_1',
        processId: '4242',
        ...params,
      })

    test('non-empty stdin → tool.call.delta on the OWNING exec call, tagged stream=stdin', async () => {
      await withCodexTui('inv_terminal_interaction_stdin', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/started', {
          threadId: T,
          turnId: 'turn_1',
          item: { type: 'commandExecution', id: 'cmd_1', command: 'psql' },
        })
        interaction(tui, { stdin: '\\dt\n' })
        const deltas = tui.ofType('tool.call.delta')
        expect(deltas.map((event) => event.payload)).toEqual([
          { toolCallId: toolCallIdFrom('cmd_1'), text: '\\dt\n', data: { stream: 'stdin' } },
        ])
        expect(deltas[0]?.turnId).toBe(turnIdFrom('turn_1'))
        // The delta joins the call the exec item opened.
        expect(tui.ofType('tool.call.started').map((event) => event.payload)).toMatchObject([
          { toolCallId: toolCallIdFrom('cmd_1') },
        ])
        // Handled, never left to the unknown-notification diagnostic.
        expect(tui.ofType('diagnostic')).toEqual([])
      })
    })

    test('empty stdin is a background-PTY poll, not content → no events', async () => {
      await withCodexTui('inv_terminal_interaction_poll', (tui) => {
        tui.startTurn('turn_1')
        const before = tui.since().length
        interaction(tui, { stdin: '' })
        expect(tui.since().slice(before)).toEqual([])
      })
    })

    test('missing turnId or itemId is dropped rather than emitting a malformed delta', async () => {
      await withCodexTui('inv_terminal_interaction_malformed', (tui) => {
        tui.emit('item/commandExecution/terminalInteraction', { itemId: 'cmd_1', stdin: 'y' })
        tui.emit('item/commandExecution/terminalInteraction', { turnId: 'turn_1', stdin: 'y' })
        expect(tui.ofType('tool.call.delta')).toEqual([])
      })
    })
  })

  describe('imageGeneration item (T-07726)', () => {
    test('a started generation is a tool call, no longer dropped', async () => {
      await withCodexTui('inv_image_generation_started', (tui) => {
        tui.startTurn('turn_1')
        tui.emit('item/started', {
          threadId: T,
          turnId: 'turn_1',
          item: { type: 'imageGeneration', id: 'img_1', status: 'in_progress', result: '' },
        })
        expect(toolEvents(tui.since()).map((event) => [event.type, event.payload])).toEqual([
          ['tool.call.started', { toolCallId: toolCallIdFrom('img_1'), name: 'image_generation' }],
        ])
      })
    })

    test('the base64 image NEVER reaches the event; only the artifact path and its size do', async () => {
      const base64 = 'iVBORw0KGgo'.repeat(50_000)
      await withCodexTui('inv_image_generation_base64', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'imageGeneration',
          id: 'img_1',
          status: 'completed',
          revisedPrompt: 'A wide engineering timeline chart.',
          result: base64,
          savedPath: '/tmp/codex/img_1.png',
        })
        expect(toolEvents(tui.since()).map((event) => [event.type, event.payload])).toEqual([
          [
            'tool.call.completed',
            {
              toolCallId: toolCallIdFrom('img_1'),
              name: 'image_generation',
              result: {
                savedPath: '/tmp/codex/img_1.png',
                prompt: 'A wide engineering timeline chart.',
                encodedBytes: base64.length,
              },
              isError: false,
            },
          ],
        ])
        expect(JSON.stringify(tui.since())).not.toContain('iVBORw0KGgo')
      })
    })

    test('an oversized revised prompt is clipped, not carried whole', async () => {
      await withCodexTui('inv_image_generation_prompt_clip', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'imageGeneration',
          id: 'img_1',
          status: 'completed',
          revisedPrompt: 'p'.repeat(2_000),
          result: 'abc',
        })
        const prompt = (
          tui.ofType('tool.call.completed')[0]?.payload as {
            result: { prompt: string }
          }
        ).result.prompt
        expect(prompt).toHaveLength(501)
        expect(prompt.endsWith('…')).toBe(true)
      })
    })

    test('a generation that terminated without a result is a tool.call.failed', async () => {
      await withCodexTui('inv_image_generation_failed', (tui) => {
        tui.startTurn('turn_1')
        completeItem(tui, {
          type: 'imageGeneration',
          id: 'img_1',
          status: 'failed',
          result: '',
          failure: { reason: 'moderation_blocked' },
        })
        const events = toolEvents(tui.since())
        expect(events.map((event) => event.type)).toEqual(['tool.call.failed'])
        expect(events[0]?.payload).toMatchObject({
          toolCallId: toolCallIdFrom('img_1'),
          name: 'image_generation',
          code: 'codex_failed',
        })
      })
    })
  })
})
