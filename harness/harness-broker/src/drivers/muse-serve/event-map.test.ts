/**
 * muse-serve event-map tests (T-08589, spike 3).
 *
 * Payloads mirror the live echo-turn probes against muse 1.3.0 (turn/started,
 * userMessage item/completed, turn/completed failed/authRequired) plus
 * schema-derived toolCall shapes. Wire-vocabulary coverage lives in
 * schema-compat (the real 1.4.0 -> 1.4.1 drift gate).
 */
import { describe, expect, test } from 'bun:test'
import { mapMuseNotification } from './event-map'
import type { MuseJsonRpcNotification } from './rpc-client'

const notif = (method: string, params: Record<string, unknown> = {}): MuseJsonRpcNotification => ({
  jsonrpc: '2.0',
  method,
  params,
})

describe('mapMuseNotification', () => {
  test('turn/completed failed carries code and emits usage', () => {
    const events = mapMuseNotification(
      notif('turn/completed', {
        sessionId: 's1',
        turnId: 't1',
        terminal: 'failed',
        reason: 'not logged in: run /login to add an API key',
        error: { kind: 'authRequired', message: 'not logged in', retryable: false },
        usage: { inputTokens: 3, outputTokens: 0 },
      })
    )
    expect(events.map((event) => event.type)).toEqual(['turn.failed', 'usage.updated'])
    expect(events[0]).toMatchObject({
      payload: { turnId: 't1', code: 'authRequired', message: 'not logged in' },
    })
  })

  test('userMessage items are ignored (broker-authored)', () => {
    const events = mapMuseNotification(
      notif('item/completed', {
        sessionId: 's1',
        item: { itemId: 'i1', kind: 'userMessage', turnId: 't1', status: 'completed', text: 'hi' },
      })
    )
    expect(events).toEqual([])
  })

  test('unknown methods degrade to debug diagnostics, never throw', () => {
    const events = mapMuseNotification(notif('frob/baz', {}))
    expect(events.map((event) => event.type)).toEqual(['diagnostic'])
  })

  const toolItem = (status: string, fields: Record<string, unknown>) => ({
    sessionId: 's1',
    item: { itemId: 'i1', kind: 'toolCall', turnId: 't1', status, ...fields },
  })

  test.each([
    {
      row: 'started projects tool/callId/args',
      method: 'item/started',
      params: toolItem('inProgress', {
        tool: 'shell',
        callId: 'call_abc',
        args: '{"command":"echo hi"}',
      }),
      type: 'tool.call.started',
      payload: { toolCallId: 'call_abc', name: 'shell', input: { command: 'echo hi' } },
    },
    {
      row: 'completed projects visibleOutput as the result',
      method: 'item/completed',
      params: toolItem('completed', { tool: 'shell', callId: 'call_abc', visibleOutput: 'hi\n' }),
      type: 'tool.call.completed',
      payload: { toolCallId: 'call_abc', name: 'shell', result: 'hi\n' },
    },
    {
      row: 'failed projects failureReason as the message',
      method: 'item/completed',
      params: toolItem('failed', {
        tool: 'shell',
        callId: 'call_abc',
        failureReason: 'exit 127: command not found',
      }),
      type: 'tool.call.failed',
      payload: { toolCallId: 'call_abc', name: 'shell', message: 'exit 127: command not found' },
    },
    {
      row: 'completed keeps approval-shape fallbacks (toolName/toolCallId/output)',
      method: 'item/completed',
      params: toolItem('completed', { toolName: 'shell', toolCallId: 'tc1', output: 'hi' }),
      type: 'tool.call.completed',
      payload: { toolCallId: 'tc1', name: 'shell', result: 'hi' },
    },
  ])('a toolCall item $row', ({ method, params, type, payload }) => {
    const events = mapMuseNotification(notif(method, params))
    expect(events.map((event) => event.type)).toEqual([type])
    expect(events[0]).toMatchObject({ payload })
  })
})
