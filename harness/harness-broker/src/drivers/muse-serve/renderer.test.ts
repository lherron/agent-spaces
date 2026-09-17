/**
 * Muse renderer projection tests (T-08590): bootstrap + live + seq dedup +
 * redraw over an in-memory read surface, with the muse transcript model.
 */
import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { RendererDurableReadSurface } from '../codex-app-server/renderer'
import { createMuseServeRendererProjection } from './renderer'

let seq = 0
const envelope = (type: string, payload: Record<string, unknown>): InvocationEventEnvelope => {
  seq += 1
  return {
    seq,
    invocationId: 'inv_muse_proj',
    time: 1789672000000,
    type,
    payload,
  } as InvocationEventEnvelope
}

const memorySurface = (history: InvocationEventEnvelope[]): RendererDurableReadSurface => {
  const handlers = new Set<(event: InvocationEventEnvelope) => void>()
  return {
    eventsSince: async () => ({ events: history, floor: 0 }),
    observe: (handler) => {
      handlers.add(handler)
      return { close: () => handlers.delete(handler) }
    },
    __push: (event: InvocationEventEnvelope) => {
      for (const handler of handlers) handler(event)
    },
  } as unknown as RendererDurableReadSurface & {
    __push: (event: InvocationEventEnvelope) => void
  }
}

describe('createMuseServeRendererProjection', () => {
  test('bootstraps from history, streams live, dedups replays, survives redraw', async () => {
    const lines: string[] = []
    const surface = memorySurface([
      envelope('user.message', { content: 'hi' }),
      envelope('turn.started', { turnId: 't1' }),
    ])
    const projection = createMuseServeRendererProjection({
      invocationId: 'inv_muse_proj',
      readSurface: surface,
      sink: (line) => lines.push(line),
      onEvent: () => undefined,
    })
    await projection.start()
    ;(surface as unknown as { __push: (event: InvocationEventEnvelope) => void }).__push(
      envelope('assistant.message.completed', {
        messageId: 'm1',
        content: [{ type: 'text', text: 'hello' }],
      })
    )
    expect(lines).toEqual(['you: hi', 'turn t1 started', 'assistant: hello'])
    projection.redraw()
    expect(lines).toEqual([
      'you: hi',
      'turn t1 started',
      'assistant: hello',
      'you: hi',
      'turn t1 started',
      'assistant: hello',
    ])
    projection.close()
  })
})
