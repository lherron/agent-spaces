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

const render = (
  events: Array<{ type: string; payload: Record<string, unknown> }>,
  options?: { color?: boolean }
): string[] => {
  const lines: string[] = []
  const model = createMuseTranscriptModel({
    emit: (line) => lines.push(line),
    ...(options?.color !== undefined ? { color: options.color } : {}),
  })
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

  test('folds consecutive duplicate assistant text without an intervening turn', () => {
    const lines = render([
      { type: 'turn.started', payload: { turnId: 't1' } },
      {
        type: 'assistant.message.completed',
        payload: { messageId: 'a1', content: [{ text: 'pong sent' }] },
      },
      {
        type: 'assistant.message.completed',
        payload: { messageId: 'a2', content: [{ text: 'pong sent' }] },
      },
      { type: 'turn.started', payload: { turnId: 't2' } },
      {
        type: 'assistant.message.completed',
        payload: { messageId: 'a3', content: [{ text: 'pong sent' }] },
      },
    ])
    expect(lines).toEqual([
      'turn t1 started',
      'assistant: pong sent',
      'turn t2 started',
      'assistant: pong sent',
    ])
  })

  test('renders forge lanes with color enabled', () => {
    const lines = render(
      [
        { type: 'user.message', payload: { content: 'list files' } },
        { type: 'turn.started', payload: { turnId: 't1abcdef' } },
        {
          type: 'assistant.message.completed',
          payload: { messageId: 'm1', content: [{ text: 'Hello' }] },
        },
        { type: 'tool.call.completed', payload: { toolCallId: 'c1', name: 'shell', result: 'ok' } },
        {
          type: 'turn.completed',
          payload: { turnId: 't1abcdef', usage: { inputTokens: 5, outputTokens: 4 } },
        },
        { type: 'turn.failed', payload: { turnId: 't2', message: 'boom', code: 'authRequired' } },
        { type: 'diagnostic', payload: { level: 'error', message: 'careful' } },
      ],
      { color: true }
    )
    const joined = lines.join('\n')
    // Every styled row carries SGR sequences; the shared design language shows.
    expect(joined).toContain('\x1b[')
    expect(joined).toContain('❯ ')
    expect(joined).toContain('▶ ')
    expect(joined).toContain('$ shell')
    expect(joined).toContain('✓ ')
    expect(joined).toContain('✗ ')
    expect(joined).toContain('▎')
    // No legacy plain prefixes survive in styled mode.
    expect(lines.some((line) => line.startsWith('you: '))).toBe(false)
    expect(lines.some((line) => line.startsWith('assistant: '))).toBe(false)
  })

  test('tool start header names the command from the input', () => {
    const started = {
      type: 'tool.call.started',
      payload: { toolCallId: 'c1', name: 'bash', input: { command: 'wrkq info' } },
    }
    expect(render([started])).toEqual(['tool bash started: wrkq info'])
    const styled = render([started], { color: true })
    expect(styled.some((line) => line.includes('$ bash') && line.includes('wrkq info'))).toBe(true)
    const bare = render([
      { type: 'tool.call.started', payload: { toolCallId: 'c2', name: 'bash' } },
    ])
    expect(bare).toEqual(['tool bash started'])
  })

  test('debug diagnostics stay off the pane unless verbose', () => {
    const debug = {
      type: 'diagnostic',
      payload: { level: 'debug', message: 'muse-serve context usage' },
    }
    expect(render([debug])).toEqual([])
    const lines: string[] = []
    const model = createMuseTranscriptModel({
      emit: (line) => lines.push(line),
      verbose: true,
    })
    model.apply(envelope(debug.type, debug.payload))
    expect(lines).toEqual(['[diagnostic] [debug] muse-serve context usage'])
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
