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
  redraw: () => void
  close: () => void
}

type RendererModule = {
  createCodexAppServerRendererProjection?: (options: {
    invocationId: string
    readSurface: DurableReadSurface
    sink?: ((line: string) => void) | undefined
    onEvent?: ((event: InvocationEventEnvelope) => void) | undefined
    color?: boolean | undefined
    width?: number | (() => number | undefined) | undefined
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

const ESC = '\x1b'
/** Erase-in-line: what fills a band to the pane edge in the current background. */
const ERASE_TO_EOL = `${ESC}[K`
const RESET = `${ESC}[0m`
// Built from ESC rather than written as a regex literal: a literal control
// character in a pattern is invisible in a diff and trips the lint rule.
const ANSI = new RegExp(`${ESC}\\[[0-9;]*[A-Za-z]`, 'g')

/** Strip SGR/EL escapes to leave the cells a band actually occupies. */
function visible(line: string): string {
  return line.replace(ANSI, '')
}

/** The tinted band rows — the keyline is what makes a row a lane. */
function bandLines(projection: RendererProjection): string[] {
  return projection.lines().filter((line) => visible(line).startsWith('▎'))
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
      event(11, 'usage.updated', {
        usage: {
          total: { totalTokens: 24690 },
          last: { totalTokens: 12345 },
        },
      }),
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

  test('renders the final request usage for a turn, not the lifetime cumulative total (T-06423)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'turn.started', { turnId: 'turn_1' }),
      event(2, 'usage.updated', {
        usage: {
          total: { totalTokens: 7522456 },
          last: { totalTokens: 178404 },
          modelContextWindow: 258400,
        },
      }),
      // Final shape captured from burn-in 04 (rt-d0e66738): `total` is the
      // lifetime additive counter across requests, while `last` is this request.
      event(3, 'usage.updated', {
        usage: {
          total: { totalTokens: 7701776 },
          last: { totalTokens: 179320 },
          modelContextWindow: 258400,
        },
      }),
      event(4, 'turn.completed', { turnId: 'turn_1', status: 'completed' }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()

    const rendered = textLines(projection).join('\n')
    expect(rendered).toContain('✓ done · 179,320 tok')
    expect(rendered).not.toContain('7,701,776 tok')
    projection.close()
  })

  // The live codex event-map never sets `message` on a tool.call.failed: a
  // commandExecution reports its failure as `result.exitCode` and an mcpToolCall
  // as `result.error`. A message-only read rendered a bare `✗ command` with no
  // reason (T-06401), which is why the synthetic `message: 'boom'` case above
  // did not catch it.
  test('renders a failure reason for real codex tool.call.failed payloads, which carry no message', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'turn.started', { turnId: 'turn_1' }),
      event(2, 'tool.call.started', {
        toolCallId: 'tool_1',
        name: 'command',
        input: { command: 'bunx biome check' },
      }),
      // Exactly the shape event-map.ts builds for a failed commandExecution.
      event(3, 'tool.call.failed', {
        toolCallId: 'tool_1',
        name: 'command',
        result: { output: 'scope.ts:12 lint/style/useConst\n  Prefer const', exitCode: 1 },
        isError: true,
      }),
      // ...and for a failed mcpToolCall, which reports `result.error`.
      event(4, 'tool.call.failed', {
        toolCallId: 'tool_2',
        name: 'fetch',
        result: { error: 'connection refused' },
        isError: true,
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })

    await projection.start()

    const rendered = textLines(projection).join('\n')
    expectTextInOrder(rendered, [
      '✗ command  exit 1', // exit code stands in as the reason
      '↳ scope.ts:12 lint/style/useConst', // failing output is shown, not swallowed
      '✗ fetch  connection refused', // mcp error text stands in as the reason
    ])
    // A reason is always rendered — never a bare glyph+name with a blank tail.
    expect(rendered).not.toMatch(/✗ command\s*$/m)
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

  test('expands tabs in tool output so a band never shows pane background mid-row (T-06351)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    // The real shape from captured transcripts: `rg -n` over tab-indented Go source.
    const { surface } = createReadSurface([
      event(1, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        input: { command: 'rg' },
      }),
      event(2, 'tool.call.completed', {
        toolCallId: 'c1',
        result: { output: 'internal/workflow/errors.go-245-\tcode: wrkfCodeLeaseConflict,' },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: 200,
    })

    await projection.start()
    const bands = bandLines(projection)
    expect(bands.length).toBeGreaterThan(0)
    // A tab advances the cursor without painting, so any tab reaching the pane leaves
    // the operator's background showing inside the band.
    for (const line of bands) expect(line).not.toContain('\t')
    const output = bands.find((l) => visible(l).includes('errors.go-245-'))
    expect(output).toBeDefined()
    // Expanded to real spaces that paint, and out to a tab stop so the column
    // alignment survives. Stops are measured across the whole physical row — the
    // `▎ ↳ ` gutter puts this tab at column 36, so it runs to the next stop at 40.
    const text = visible(output ?? '')
    expect(text).toBe('▎ ↳ internal/workflow/errors.go-245-    code: wrkfCodeLeaseConflict,')
    expect(text.indexOf('code:') % 8).toBe(0)
  })

  test('neutralizes C0 controls in tool output so they cannot clear the band tint (T-06351)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        input: { command: 'ls' },
      }),
      // A program that emits its own colour: the reset would clear OUR band background
      // for the remainder of the row if passed through.
      event(2, 'tool.call.completed', {
        toolCallId: 'c1',
        result: { output: `${ESC}[31mred${ESC}[0m plain` },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: 200,
    })

    await projection.start()
    const output = bandLines(projection).find((l) => visible(l).includes('plain'))
    expect(output).toBeDefined()
    // The only escapes left in the row are the ones the renderer itself emitted: the
    // band's own SGR, the erase-to-EOL, and the trailing reset. The foreign ESC bytes
    // are gone, so the tint survives to the end of the row.
    expect(output).toContain(ERASE_TO_EOL)
    expect(output?.endsWith(RESET)).toBe(true)
    expect(output?.split(ERASE_TO_EOL)[0]).not.toContain(`${ESC}[31m`)
    expect(output?.split(ERASE_TO_EOL)[0]).not.toContain(`${ESC}[0m`)
  })

  test('fills tinted bands to the pane edge with erase-to-EOL, never computed padding (T-06343)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        input: { command: 'ls' },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: 200,
    })

    await projection.start()
    const bands = bandLines(projection)
    expect(bands.length).toBeGreaterThan(0)
    for (const line of bands) {
      // The band tint reaches the row's true end via EL, so there is no trailing
      // run of padding spaces to get wrong — that padding was what left the
      // operator's own background showing on the right of every band.
      expect(line).toContain(ERASE_TO_EOL)
      expect(line.endsWith(RESET)).toBe(true)
      expect(visible(line)).not.toMatch(/ {4,}$/)
    }
    projection.close()
  })

  test('clips band content one column short of the pane so a row never wraps away its keyline (T-06343)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        // Longer than the pane AND longer than the renderer's own 120-char preview
        // clip — the preview budget is independent of the pane, so only a band-level
        // clip keeps this row on one physical line.
        input: { command: `/bin/zsh -lc '${'git status --short && '.repeat(20)}'` },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: 60,
    })

    await projection.start()
    const bands = bandLines(projection)
    expect(bands.length).toBeGreaterThan(0)
    for (const line of bands) {
      expect(visible(line).length).toBeLessThanOrEqual(59)
    }
    projection.close()
  })

  test('resolves pane width per row, so a resize after launch is picked up (T-06343)', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface, emitLive } = createReadSurface([
      event(1, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        input: { command: 'a'.repeat(300) },
      }),
    ])
    // The pane starts at tmux's 80-column default and is widened once a client
    // attaches — exactly the sequence that pinned every band to 80 when the width
    // was snapshotted at construction.
    let columns = 80
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: () => columns,
    })

    await projection.start()
    // Narrow pane: the row is clipped to one column short of it.
    const beforeResize = bandLines(projection).at(-1)
    expect(visible(beforeResize ?? '').length).toBe(79)

    columns = 200
    emitLive(
      event(2, 'tool.call.started', {
        toolCallId: 'c2',
        name: 'command',
        input: { command: 'b'.repeat(300) },
      })
    )
    // Wide pane: the same row is no longer clipped at the stale 79 (it now runs to
    // the preview budget, and EL carries the tint the rest of the way). A width
    // snapshotted at construction would still cut it at 79.
    const afterResize = bandLines(projection).at(-1)
    expect(visible(afterResize ?? '').length).toBeGreaterThan(79)
    expect(visible(afterResize ?? '').length).toBeLessThanOrEqual(199)
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

describe('codex-app-server renderer region spacing (T-06365)', () => {
  test('agent prose is bracketed by a blank row on BOTH sides, like every other region', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'turn.started', { turnId: 'turn_1' }),
      event(2, 'assistant.message.completed', { messageId: 'm1', text: 'Here is the plan.' }),
      // The band that used to butt straight up against the prose.
      event(3, 'tool.call.started', {
        toolCallId: 'c1',
        name: 'command',
        input: { command: 'bun test' },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })
    await projection.start()

    const rendered = projection.lines().map((l) => visible(l))
    const prose = rendered.findIndex((l) => l.includes('Here is the plan.'))
    const band = rendered.findIndex((l) => l.includes('bun test'))
    expect(prose).toBeGreaterThan(-1)
    expect(band).toBeGreaterThan(prose)
    // Prose has no lane, so the negative space around it IS its boundary. Equal on
    // both sides: one blank above, one blank below.
    expect(rendered[prose - 1]).toBe('')
    expect(rendered[prose + 1]).toBe('')
    projection.close()
  })

  test('every content region brackets itself, so none of them runs into the next', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'user.message', { content: 'do the thing' }),
      event(2, 'turn.started', { turnId: 'turn_1' }),
      event(3, 'assistant.message.completed', { messageId: 'm1', text: 'Doing the thing.' }),
      event(4, 'diagnostic', {
        level: 'info',
        source: 'driver',
        kind: 'diff',
        message: 'diff updated',
        data: { totalAdded: 1, totalRemoved: 0, files: [{ path: 'a.ts', added: 1, removed: 0 }] },
      }),
    ])
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
    })
    await projection.start()

    const rendered = projection.lines().map((l) => visible(l))
    // A region is a contiguous block of non-blank rows (a diff card is a header row
    // plus a row per file). The rule is about the block, not any single row: it is
    // separated from whatever precedes and follows it by a blank.
    for (const marker of ['do the thing', 'Doing the thing.', 'a.ts']) {
      const at = rendered.findIndex((l) => l.includes(marker))
      expect(at, `missing ${marker}`).toBeGreaterThan(-1)
      let start = at
      while (start > 0 && rendered[start - 1] !== '') start -= 1
      let end = at
      while (end < rendered.length - 1 && rendered[end + 1] !== '') end += 1
      // Not at an edge: a blank row actually exists on each side of the block.
      expect(start, `${marker} block opens the pane with no blank above`).toBeGreaterThan(0)
      expect(end, `${marker} block ends the pane with no blank below`).toBeLessThan(
        rendered.length - 1
      )
    }
    projection.close()
  })
})

describe('codex-app-server renderer redraw on pane resize (T-06365)', () => {
  test('re-renders committed rows at the NEW width, so a pane widened after launch is not stuck with 80-column rows', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const prose = 'word '.repeat(60).trim()
    const { surface } = createReadSurface([event(1, 'user.message', { content: prose })])

    // The real launch shape: exec'd into a pane still at tmux's 80-column default.
    let columns = 80
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      color: true,
      width: () => columns,
    })
    await projection.start()

    const narrowest = Math.max(...bandLines(projection).map((line) => visible(line).length))
    expect(narrowest).toBeLessThanOrEqual(80)

    // A client attaches and the pane widens.
    columns = 130
    projection.redraw()

    const widest = Math.max(...bandLines(projection).map((line) => visible(line).length))
    // The rows are re-wrapped to the wider measure — the whole point. Without the
    // redraw these rows keep the ~78-column wrap they were committed with.
    expect(widest).toBeGreaterThan(narrowest)
    expect(widest).toBeLessThanOrEqual(130)
    projection.close()
  })

  test('a redraw replaces the transcript rather than appending a second copy', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'assistant.message.completed', { messageId: 'm1', text: 'Only once please' }),
    ])
    const emitted: string[] = []
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      sink: (line) => emitted.push(line),
    })
    await projection.start()
    projection.redraw()

    // `lines()` is the pane's content, not a log: it must hold ONE transcript.
    expect(
      projection
        .lines()
        .join('\n')
        .match(/Only once please/g)
    ).toHaveLength(1)
    // The sink, by contrast, legitimately sees it twice — the caller clears the
    // pane between the two, which is exactly why lines() must not accumulate.
    expect(emitted.join('\n').match(/Only once please/g)).toHaveLength(2)
    projection.close()
  })

  test('a redraw does not re-fire onEvent, so the status row keeps its elapsed clock', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const { surface } = createReadSurface([
      event(1, 'turn.started', { turnId: 'turn_1' }),
      event(2, 'tool.call.started', { toolCallId: 'c1', name: 'command', input: {} }),
    ])
    const observed: string[] = []
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: surface,
      onEvent: (e) => observed.push(e.type),
    })
    await projection.start()
    expect(observed).toEqual(['turn.started', 'tool.call.started'])

    projection.redraw()
    // Re-observing a replayed turn.started would restart the running row's clock,
    // so a mid-turn resize would visibly reset a counter timing a real wait.
    expect(observed).toEqual(['turn.started', 'tool.call.started'])
    projection.close()
  })

  test('a read failure survives a redraw, in the place it happened', async () => {
    const { createCodexAppServerRendererProjection } = await loadRendererModule()
    const readError = Object.assign(new Error('events before seq 7 are no longer retained'), {
      code: BrokerErrorCode.EventReplayUnavailable,
      data: { retentionFloorSeq: 7 },
    })
    const handlers = new Set<(event: InvocationEventEnvelope) => void>()
    const projection = createCodexAppServerRendererProjection({
      invocationId: 'inv_renderer',
      readSurface: {
        eventsSince: async () => {
          throw readError
        },
        observe: (handler) => {
          handlers.add(handler)
          return { close: () => handlers.delete(handler) }
        },
      },
    })
    await projection.start()
    for (const handler of handlers) {
      handler(event(8, 'assistant.message.completed', { messageId: 'm1', text: 'after the gap' }))
    }
    projection.redraw()

    // A retention gap is never silently dropped (daedalus invariant) — and a
    // resize is not a licence to drop it either. It stays ahead of the events
    // that followed it.
    expectTextInOrder(textLines(projection).join('\n'), ['retention', 'after the gap'])
    projection.close()
  })
})
