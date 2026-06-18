import { describe, expect, test } from 'bun:test'
import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'

type EventsSinceRequest = {
  invocationId: string
  afterSeq: number
}

type EventsSinceResponse = {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq?: number | undefined
}

type DurableReadSurface = {
  eventsSince: (request: EventsSinceRequest) => Promise<EventsSinceResponse>
  observe: (handler: (event: InvocationEventEnvelope) => void) => { close: () => void }
}

type RendererProjection = {
  start: () => Promise<void>
  lines: () => string[]
  close: () => void
}

type RendererModule = {
  createCodexAppServerRendererProjection?: (options: {
    invocationId: string
    readSurface: DurableReadSurface
  }) => RendererProjection
}

const rendererModulePath = ['../../../src/drivers/codex-app-server', 'renderer'].join('/')

async function loadRendererModule(): Promise<Required<RendererModule>> {
  let loaded: RendererModule
  try {
    loaded = (await import(rendererModulePath)) as RendererModule
  } catch (error) {
    throw new Error(
      `Expected ${rendererModulePath}.ts to implement the Phase B durable renderer projection seam`,
      { cause: error }
    )
  }
  if (loaded.createCodexAppServerRendererProjection === undefined) {
    throw new Error(
      `${rendererModulePath}.ts must export createCodexAppServerRendererProjection(options)`
    )
  }
  return loaded as Required<RendererModule>
}

function event(
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: unknown,
  invocationId = 'inv_renderer'
): InvocationEventEnvelope {
  return {
    invocationId,
    seq,
    time: `2026-06-18T15:40:${seq.toString().padStart(2, '0')}.000Z`,
    type,
    payload,
  } as InvocationEventEnvelope
}

function createReadSurface(replay: InvocationEventEnvelope[]): {
  surface: DurableReadSurface
  emitLive: (event: InvocationEventEnvelope) => void
  eventsSinceRequests: EventsSinceRequest[]
} {
  const handlers = new Set<(event: InvocationEventEnvelope) => void>()
  const eventsSinceRequests: EventsSinceRequest[] = []
  return {
    eventsSinceRequests,
    surface: {
      eventsSince: async (request) => {
        eventsSinceRequests.push(request)
        return {
          events: replay.filter(
            (item) => item.invocationId === request.invocationId && item.seq > request.afterSeq
          ),
          currentSeq: Math.max(0, ...replay.map((item) => item.seq)),
          retentionFloorSeq: 0,
        }
      },
      observe: (handler) => {
        handlers.add(handler)
        return { close: () => handlers.delete(handler) }
      },
    },
    emitLive: (liveEvent) => {
      for (const handler of handlers) handler(liveEvent)
    },
  }
}

function textLines(projection: RendererProjection): string[] {
  return projection.lines().filter((line) => line.trim().length > 0)
}

function expectTextInOrder(text: string, snippets: string[]): void {
  let cursor = -1
  for (const snippet of snippets) {
    const next = text.indexOf(snippet, cursor + 1)
    expect(
      next,
      `missing ${JSON.stringify(snippet)} after offset ${cursor} in:\n${text}`
    ).toBeGreaterThan(cursor)
    cursor = next
  }
}

describe('codex-app-server renderer durable read projection (T-04909 Phase B red)', () => {
  test('bootstraps from invocation.eventsSince, subscribes to live invocation.event, preserves seq order, and dedupes only replay/live overlap', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface, emitLive, eventsSinceRequests } = createReadSurface([
      event(1, 'invocation.ready', { state: 'ready' }),
      event(2, 'assistant.message.delta', { messageId: 'msg_1', text: 'Replay delta' }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    // T-04909: renderer source of truth is the broker's durable read surface.
    // It must bootstrap via invocation.eventsSince before accepting live
    // invocation.event notifications; a driver-pushed private feed is not enough.
    await projection.start()
    emitLive(event(2, 'assistant.message.delta', { messageId: 'msg_1', text: 'Replay delta' }))
    emitLive(
      event(
        2,
        'assistant.message.delta',
        { messageId: 'other', text: 'Other invocation' },
        'inv_other'
      )
    )
    emitLive(event(3, 'assistant.message.completed', { messageId: 'msg_1', text: 'Done' }))

    expect(eventsSinceRequests).toEqual([{ invocationId: 'inv_renderer', afterSeq: 0 }])
    const lines = textLines(projection)
    expect(lines).toHaveLength(3)
    expect(lines.join('\n')).toContain('ready')
    expect(lines.join('\n')).toContain('Replay delta')
    expect(lines.join('\n')).toContain('Done')
    expect(lines.join('\n')).not.toContain('Other invocation')
    expect(lines.join('\n').match(/Replay delta/g)).toHaveLength(1)
    expect(lines.map((line) => Number(line.match(/\bseq=(\d+)\b/)?.[1] ?? Number.NaN))).toEqual([
      1, 2, 3,
    ])
    projection.close()
  })

  test('renders representative broker events in seq order, including user input, tools, diagnostics, status, and summary', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'user.message', { role: 'user', inputId: 'input_1', content: 'Run the check' }),
      event(2, 'invocation.ready', { state: 'ready' }),
      event(3, 'assistant.message.delta', { messageId: 'msg_1', text: 'I will run it.' }),
      event(4, 'tool.call.started', { callId: 'tool_1', name: 'shell', input: 'bun test' }),
      event(5, 'tool.call.delta', { callId: 'tool_1', text: 'running' }),
      event(6, 'tool.call.completed', { callId: 'tool_1', output: 'ok' }),
      event(7, 'tool.call.failed', { callId: 'tool_2', name: 'shell', message: 'boom' }),
      event(8, 'diagnostic', { level: 'warn', source: 'harness', message: 'slow read' }),
      event(9, 'assistant.message.completed', { messageId: 'msg_1', text: 'All set.' }),
      event(10, 'turn.completed', {
        turnId: 'turn_1',
        status: 'completed',
        finalOutput: 'All set.',
      }),
      event(11, 'invocation.summary', {
        summary: { driver: 'codex-app-server', turnsCompleted: 1 },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()

    const rendered = textLines(projection).join('\n')
    expectTextInOrder(rendered, [
      'Run the check',
      'ready',
      'I will run it.',
      'shell',
      'running',
      'ok',
      'boom',
      'slow read',
      'All set.',
      'completed',
      'turnsCompleted',
    ])
    projection.close()
  })

  test('surfaces retention-gap and read-surface failures visibly instead of silently dropping renderer output', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const readError = Object.assign(new Error('events before seq 7 are no longer retained'), {
      code: BrokerErrorCode.EventReplayUnavailable,
      data: { retentionFloorSeq: 7 },
    })
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: {
        eventsSince: async () => {
          throw readError
        },
        observe: () => ({ close: () => undefined }),
      },
    })

    await projection.start()

    const rendered = textLines(projection).join('\n')
    expect(rendered).toContain('renderer')
    expect(rendered).toContain('retention')
    expect(rendered).toContain('seq 7')
    expect(rendered).toContain(BrokerErrorCode.EventReplayUnavailable)
    projection.close()
  })
})
