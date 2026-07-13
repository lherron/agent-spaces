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
      event(2, 'assistant.message.completed', { messageId: 'msg_1', text: 'Replay message' }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    // T-04909: renderer source of truth is the broker's durable read surface.
    // It must bootstrap via invocation.eventsSince before accepting live
    // invocation.event notifications; a driver-pushed private feed is not enough.
    await projection.start()
    emitLive(
      event(2, 'assistant.message.completed', { messageId: 'msg_1', text: 'Replay message' })
    )
    emitLive(
      event(
        2,
        'assistant.message.completed',
        { messageId: 'other', text: 'Other invocation' },
        'inv_other'
      )
    )
    emitLive(event(3, 'turn.completed', { turnId: 'turn_1', status: 'completed' }))

    expect(eventsSinceRequests).toEqual([{ invocationId: 'inv_renderer', afterSeq: 0 }])
    const rendered = textLines(projection).join('\n')
    // Strict seq order is preserved as transcript order: ready → message → done.
    expectTextInOrder(rendered, ['ready', 'Replay message', '✓ done'])
    // A replayed-then-live duplicate (same seq) renders once; a live event for a
    // different invocation never bleeds in.
    expect(rendered).not.toContain('Other invocation')
    expect(rendered.match(/Replay message/g)).toHaveLength(1)
    projection.close()
  })

  test('renders a full turn hrcchat-style: prompt, turn header, grouped tools, diagnostics, bold answer, and footer', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'user.message', { role: 'user', inputId: 'input_1', content: 'Run the check' }),
      event(2, 'invocation.ready', { state: 'ready' }),
      event(3, 'turn.started', { turnId: 'turn_1' }),
      event(4, 'assistant.message.started', { messageId: 'msg_1' }),
      event(5, 'assistant.message.delta', { messageId: 'msg_1', text: 'I will run it.' }),
      event(6, 'tool.call.started', {
        toolCallId: 'tool_1',
        name: 'command',
        input: { command: 'bun test' },
      }),
      event(7, 'tool.call.delta', { toolCallId: 'tool_1', text: 'streaming-chunk' }),
      event(8, 'tool.call.completed', {
        toolCallId: 'tool_1',
        result: { output: 'ok', exitCode: 0 },
      }),
      event(9, 'tool.call.failed', { toolCallId: 'tool_2', name: 'command', message: 'boom' }),
      event(10, 'diagnostic', { level: 'warn', source: 'harness', message: 'slow read' }),
      event(11, 'usage.updated', { usage: { total: { totalTokens: 12345 } } }),
      event(12, 'assistant.message.completed', { messageId: 'msg_1', text: 'All set.' }),
      event(13, 'turn.completed', {
        turnId: 'turn_1',
        status: 'completed',
        finalOutput: 'All set.',
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()

    const rendered = textLines(projection).join('\n')
    expectTextInOrder(rendered, [
      '❯ Run the check', // user prompt — full input, indigo band
      '● ready', // ready beat
      '▶ turn', // turn header
      '$ command', // grouped tool (started)
      '↳ ok', // grouped tool output (completed)
      '✗ command  boom', // failed tool
      '⚠ slow read', // diagnostic surfaced (warn)
      'All set.', // coalesced assistant answer
      '✓ done · 12,345 tok', // footer with usage
    ])
    // Streaming delta events are folded into their *.completed event — never
    // rendered per-chunk.
    expect(rendered).not.toContain('I will run it.')
    expect(rendered).not.toContain('streaming-chunk')
    projection.close()
  })

  test('renders every emitted lifecycle/telemetry event type with a dedicated form, never the raw-JSON fallback', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    // The exact set the live codex-app-server invocation emits that previously
    // fell through to the `seq=<n> <type> {json}` default branch.
    const { surface } = createReadSurface([
      event(1, 'lifecycle.policy.accepted', {
        policyId: 'policy-route-headless-broker:codex-app-server',
        retentionMode: 'keep-alive',
      }),
      event(2, 'terminal.surface.reported', { kind: 'tmux-pane', paneId: '%1' }),
      event(3, 'invocation.started', { pid: 91871, command: '/usr/bin/codex' }),
      event(4, 'continuation.updated', { provider: 'codex', kind: 'thread', key: 'thr_1' }),
      event(5, 'input.accepted', { inputId: 'input_1', disposition: 'started' }),
      event(6, 'assistant.message.started', { messageId: 'msg_1' }),
      event(7, 'usage.updated', {
        usage: { total: { totalTokens: 20140, inputTokens: 20062, outputTokens: 78 } },
      }),
      event(8, 'assistant.message.completed', {
        messageId: 'msg_1',
        content: [{ type: 'text', text: 'From content array' }],
        final: false,
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()

    const lines = textLines(projection)
    const rendered = lines.join('\n')
    // Every broker-specific type (ones hrcchat turn never emits) renders with a
    // dedicated friendly form, in order.
    expectTextInOrder(rendered, [
      'policy policy-route-headless-broker:codex-app-server (keep-alive)',
      'surface tmux-pane %1',
      'process pid=91871',
      'thread thr_1',
      'input started',
      'From content array', // assistant content[] extracted
    ])
    // Per-step usage updates are folded into the turn footer, never rendered as
    // their own line (a codex turn emits dozens of them).
    expect(rendered).not.toContain('20,140 tok')
    // None may degrade to a raw-JSON object dump.
    for (const line of lines) {
      expect(line, `event rendered via raw-JSON fallback:\n${line}`).not.toMatch(/\s\{".*":/)
    }
    projection.close()
  })

  test('renders the FULL multi-line user input, not just the clipped priming first line (T-06325)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'user.message', {
        role: 'user',
        inputId: 'input_1',
        // The priming preamble is the first line; the real dispatched
        // instruction follows on later lines and must NOT be truncated away.
        content: 'You are cody working on T-1.\n\nTake T-1 end to end and commit on main.',
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()
    const rendered = textLines(projection).join('\n')
    expectTextInOrder(rendered, [
      '❯ You are cody working on T-1.',
      'Take T-1 end to end and commit on main.',
    ])
    projection.close()
  })

  test('renders plan and diff updates as structured cards, folds debug diagnostics (T-06325)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'diagnostic', {
        level: 'info',
        source: 'driver',
        kind: 'plan',
        message: 'plan updated (2 steps)',
        data: {
          steps: [
            { step: 'Write the failing test', status: 'inProgress' },
            { step: 'Ship the fix', status: 'pending' },
          ],
        },
      }),
      event(2, 'diagnostic', {
        level: 'info',
        source: 'driver',
        kind: 'diff',
        message: 'diff updated',
        data: {
          files: [{ path: 'src/renderer.ts', added: 18, removed: 6 }],
          totalAdded: 18,
          totalRemoved: 6,
          truncated: 0,
        },
      }),
      // A debug diagnostic (unknown native notification) is folded away entirely.
      event(3, 'diagnostic', {
        level: 'debug',
        source: 'driver',
        message: 'Unhandled Codex notification: thread/whatever',
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()
    const rendered = textLines(projection).join('\n')
    expectTextInOrder(rendered, [
      'plan',
      'Write the failing test',
      'Ship the fix',
      'src/renderer.ts',
    ])
    expect(rendered).not.toContain('Unhandled Codex notification')
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
    expect(rendered).toContain(String(BrokerErrorCode.EventReplayUnavailable))
    projection.close()
  })
})
