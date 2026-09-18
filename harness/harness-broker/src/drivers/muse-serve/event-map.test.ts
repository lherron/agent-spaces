/**
 * muse-serve event-map tests (T-08589, spike 3).
 *
 * Payloads mirror the live echo-turn probes against muse 1.3.0 (turn/started,
 * userMessage item/completed, turn/completed failed/authRequired) plus
 * schema-derived agentMessage/toolCall shapes. The method-coverage test pins
 * the 1.3.0 wire vocabulary: a new muse version adding methods fails here
 * until the map classifies them.
 */
import { describe, expect, test } from 'bun:test'
import { classifyMuseNotificationMethod, mapMuseNotification } from './event-map'
import type { MuseJsonRpcNotification } from './rpc-client'

const notif = (method: string, params: Record<string, unknown> = {}): MuseJsonRpcNotification => ({
  jsonrpc: '2.0',
  method,
  params,
})

describe('mapMuseNotification', () => {
  test('turn/started mints a broker-delivery bracket', () => {
    const events = mapMuseNotification(
      notif('turn/started', { sessionId: 's1', turnId: 't1', commandId: 't1' })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'turn.started', payload: { turnId: 't1' } })
  })

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

  test('turn/completed cancelled maps to turn.interrupted', () => {
    const events = mapMuseNotification(
      notif('turn/completed', { sessionId: 's1', turnId: 't1', terminal: 'cancelled' })
    )
    expect(events.map((event) => event.type)).toEqual(['turn.interrupted'])
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

  test('agentMessage completion reports text and notifies the transcript observer', () => {
    const seen: Array<[string, string]> = []
    const events = mapMuseNotification(
      notif('item/completed', {
        sessionId: 's1',
        item: {
          itemId: 'm1',
          kind: 'agentMessage',
          turnId: 't1',
          status: 'completed',
          text: 'done',
        },
      }),
      { onAgentText: (turnId, text) => seen.push([turnId, text]) }
    )
    expect(events.map((event) => event.type)).toEqual(['assistant.message.completed'])
    expect(seen).toEqual([['t1', 'done']])
  })

  test('unknown methods degrade to debug diagnostics, never throw', () => {
    const events = mapMuseNotification(notif('frob/baz', {}))
    expect(events.map((event) => event.type)).toEqual(['diagnostic'])
  })

  test('toolCall started projects MSP turn-item fields (tool/callId/args)', () => {
    const events = mapMuseNotification(
      notif('item/started', {
        sessionId: 's1',
        item: {
          itemId: 'i1',
          kind: 'toolCall',
          turnId: 't1',
          status: 'inProgress',
          tool: 'shell',
          callId: 'call_abc',
          args: '{"command":"echo hi"}',
        },
      })
    )
    expect(events.map((event) => event.type)).toEqual(['tool.call.started'])
    expect(events[0]).toMatchObject({
      payload: {
        toolCallId: 'call_abc',
        name: 'shell',
        input: { command: 'echo hi' },
      },
    })
  })

  test('toolCall completed projects visibleOutput as the result', () => {
    const events = mapMuseNotification(
      notif('item/completed', {
        sessionId: 's1',
        item: {
          itemId: 'i1',
          kind: 'toolCall',
          turnId: 't1',
          status: 'completed',
          tool: 'shell',
          callId: 'call_abc',
          visibleOutput: 'hi\n',
        },
      })
    )
    expect(events.map((event) => event.type)).toEqual(['tool.call.completed'])
    expect(events[0]).toMatchObject({
      payload: { toolCallId: 'call_abc', name: 'shell', result: 'hi\n' },
    })
  })

  test('toolCall failed projects failureReason as the message', () => {
    const events = mapMuseNotification(
      notif('item/completed', {
        sessionId: 's1',
        item: {
          itemId: 'i1',
          kind: 'toolCall',
          turnId: 't1',
          status: 'failed',
          tool: 'shell',
          callId: 'call_abc',
          failureReason: 'exit 127: command not found',
        },
      })
    )
    expect(events.map((event) => event.type)).toEqual(['tool.call.failed'])
    expect(events[0]).toMatchObject({
      payload: {
        toolCallId: 'call_abc',
        name: 'shell',
        message: 'exit 127: command not found',
      },
    })
  })

  test('toolCall keeps approval-shape fallbacks (toolName/toolCallId)', () => {
    const events = mapMuseNotification(
      notif('item/completed', {
        sessionId: 's1',
        item: {
          itemId: 'i1',
          kind: 'toolCall',
          turnId: 't1',
          status: 'completed',
          toolName: 'shell',
          toolCallId: 'tc1',
          output: 'hi',
        },
      })
    )
    expect(events.map((event) => event.type)).toEqual(['tool.call.completed'])
    expect(events[0]).toMatchObject({
      payload: { toolCallId: 'tc1', name: 'shell', result: 'hi' },
    })
  })
})

describe('muse wire vocabulary coverage (1.3.0 export)', () => {
  const mapped = [
    'turn/started',
    'turn/completed',
    'turn/retracted',
    'item/started',
    'item/delta',
    'item/updated',
    'item/completed',
    'session/tokenUsage',
    'usage/changed',
    'session/contextUsage',
    'view/gap',
  ]
  const ignoredKnown = [
    'initialized',
    'session/started',
    'session/statusChanged',
    'session/approvalModeChanged',
    'session/branchChanged',
    'session/goalChanged',
    'session/modelChanged',
    'session/modelRouteUnserved',
    'session/nameChanged',
    'session/reasoningEffortChanged',
    'session/todoListChanged',
    'session/viewHealthChanged',
    'skill/changed',
    'approval/requested',
    'approval/updated',
    'approval/resolved',
    'userInput/requested',
    'userInput/settled',
    'turn/unqueued',
    'turn/retryScheduled',
  ]
  const liveMethods = [
    'initialize',
    'initialized',
    'session/start',
    'session/resume',
    'session/compact',
    'session/fork',
    'session/list',
    'session/read',
    'session/rename',
    'session/setApprovalMode',
    'session/setModel',
    'session/setReasoningEffort',
    'session/userShell',
    'turn/start',
    'turn/steer',
    'turn/cancel',
    'turn/interrupt',
    'turn/unqueue',
    'approval/decide',
    'approval/listPending',
    'userInput/answer',
    'userInput/cancel',
    'userInput/clarify',
    'model/list',
    'skill/list',
    'item/readOutput',
    'usage/read',
    ...mapped,
    ...ignoredKnown,
  ]

  test('every notification the host can push is classified', () => {
    const notifications = [
      'initialized',
      'approval/requested',
      'approval/resolved',
      'approval/updated',
      'item/completed',
      'item/delta',
      'item/started',
      'item/updated',
      'session/approvalModeChanged',
      'session/branchChanged',
      'session/contextUsage',
      'session/goalChanged',
      'session/modelChanged',
      'session/modelRouteUnserved',
      'session/nameChanged',
      'session/reasoningEffortChanged',
      'session/statusChanged',
      'session/todoListChanged',
      'session/tokenUsage',
      'session/viewHealthChanged',
      'skill/changed',
      'turn/completed',
      'turn/retracted',
      'turn/retryScheduled',
      'turn/started',
      'turn/unqueued',
      'usage/changed',
      'userInput/requested',
      'userInput/settled',
      'view/gap',
    ]
    for (const method of notifications) {
      expect(classifyMuseNotificationMethod(method)).not.toBe('unknown')
    }
    expect(liveMethods).toContain('turn/steer')
  })
})
