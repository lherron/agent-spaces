/**
 * Muse transcript model tests (T-08590).
 */
import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createMuseTranscriptModel } from './transcript'

let seq = 0
const envelope = (type: string, payload: Record<string, unknown>): InvocationEventEnvelope => {
  seq += 1
  return {
    seq,
    invocationId: 'inv_muse_r',
    time: 1789672000000,
    type,
    payload,
  } as InvocationEventEnvelope
}

const render = (events: Array<{ type: string; payload: Record<string, unknown> }>): string[] => {
  const lines: string[] = []
  const model = createMuseTranscriptModel({ emit: (line) => lines.push(line) })
  for (const event of events) model.apply(envelope(event.type, event.payload))
  return lines
}

describe('createMuseTranscriptModel', () => {
  test('projects user, turn, assistant, tool, usage, and diagnostic events', () => {
    const lines = render([
      { type: 'user.message', payload: { content: 'list files' } },
      { type: 'turn.started', payload: { turnId: 't1' } },
      { type: 'assistant.message.delta', payload: { messageId: 'm1', text: 'Hel' } },
      { type: 'assistant.message.delta', payload: { messageId: 'm1', text: 'lo' } },
      { type: 'assistant.message.completed', payload: { messageId: 'm1', content: [] } },
      { type: 'tool.call.completed', payload: { toolCallId: 'c1', name: 'shell', result: 'ok' } },
      { type: 'turn.completed', payload: { turnId: 't1', usage: { inputTokens: 5 } } },
    ])
    expect(lines).toEqual([
      'you: list files',
      'turn t1 started',
      'assistant: Hello',
      'tool shell completed: ok',
      'turn t1 completed',
      'usage: {"inputTokens":5}',
    ])
  })

  test('projects failures, interruptions, and permissions', () => {
    const lines = render([
      { type: 'turn.failed', payload: { turnId: 't2', message: 'boom', code: 'authRequired' } },
      { type: 'turn.interrupted', payload: { turnId: 't3' } },
      { type: 'permission.requested', payload: { kind: 'shell', defaultDecision: 'deny' } },
      { type: 'permission.resolved', payload: { permissionRequestId: 'p1', decision: 'deny' } },
      { type: 'diagnostic', payload: { level: 'warn', message: 'careful' } },
    ])
    expect(lines).toEqual([
      'turn t2 failed: boom (authRequired)',
      'turn t3 interrupted',
      'permission shell requested (default deny)',
      'permission p1: deny',
      '[warn] careful',
    ])
  })
})
