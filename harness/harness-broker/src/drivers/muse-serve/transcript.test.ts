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
        {
          type: 'tool.call.started',
          payload: { toolCallId: 'c1', name: 'shell', input: { command: 'ls' } },
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
    expect(joined).toContain('$')
    expect(joined).toContain('ls')
    expect(joined).toContain('✓ ')
    expect(joined).toContain('✗ ')
    // Tint blocks separate sections — no keyline gutters, no tool names.
    expect(joined).not.toContain('▎')
    expect(joined).not.toContain('shell')
    // No legacy plain prefixes survive in styled mode.
    expect(lines.some((line) => line.startsWith('you: '))).toBe(false)
    expect(lines.some((line) => line.startsWith('assistant: '))).toBe(false)
  })

  test('tool start header shows the command with a bare $ marker', () => {
    const started = {
      type: 'tool.call.started',
      payload: { toolCallId: 'c1', name: 'bash', input: { command: 'wrkq info' } },
    }
    expect(render([started])).toEqual(['tool bash started: wrkq info'])
    const styled = render([started], { color: true })
    expect(styled.some((line) => line.includes('wrkq info'))).toBe(true)
    expect(styled.some((line) => line.includes('bash'))).toBe(false)
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

  test('usage payloads stay off the pane unless verbose', () => {
    const update = {
      type: 'usage.updated',
      payload: { usage: { inputTokens: 25008, outputTokens: 203 } },
    }
    expect(render([update])).toEqual([])
    const lines: string[] = []
    const model = createMuseTranscriptModel({
      emit: (line) => lines.push(line),
      verbose: true,
    })
    model.apply(envelope(update.type, update.payload))
    expect(lines).toEqual(['[usage.updated] usage: {"inputTokens":25008,"outputTokens":203}'])
  })

  test('tool output renders without header, capped at four lines', () => {
    const lines = render(
      [
        {
          type: 'tool.call.completed',
          payload: { toolCallId: 'c1', name: 'bash', result: 'l1\nl2\nl3\nl4\nl5\nl6\n' },
        },
      ],
      { color: true }
    )
    expect(lines).toHaveLength(5)
    const joined = lines.join('\n')
    for (const row of ['  l1', '  l2', '  l3', '  l4']) {
      expect(joined).toContain(row)
    }
    expect(joined).toContain('  … (2 more lines)')
    expect(joined).not.toContain('l5')
    expect(lines.some((line) => line.includes('$ bash'))).toBe(false)
    // Output rows sit inside the tool tint block with no keyline; the
    // truncation marker is dimmed to the palette floor.
    expect(joined).toContain('48;2;18;38;28')
    expect(joined).not.toContain('▎')
    const marker = lines.find((line) => line.includes('more lines')) ?? ''
    expect(marker).toContain('104;99;92')
    const short = render(
      [{ type: 'tool.call.completed', payload: { toolCallId: 'c2', name: 'bash', result: 'ok' } }],
      { color: true }
    )
    expect(short).toHaveLength(1)
    expect(short[0]).toContain('  ok')
    const empty = render(
      [{ type: 'tool.call.completed', payload: { toolCallId: 'c3', name: 'bash', result: '' } }],
      { color: true }
    )
    expect(empty).toEqual([])
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
