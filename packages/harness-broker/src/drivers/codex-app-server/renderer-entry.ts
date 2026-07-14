#!/usr/bin/env bun
/**
 * T-04906 / T-04909 Phase B — Codex app-server renderer entry process.
 *
 * Launched by the codex-app-server driver into the HRC-leased `tmux-tui` pane
 * (see {@link buildRendererLaunchCommand}). It connects to the broker's
 * read-only observer/broker socket, bootstraps from `invocation.eventsSince`,
 * subscribes to live `invocation.event` notifications, and projects them into
 * the pane via {@link createCodexAppServerRendererProjection}.
 *
 * This is a presentation/observation process ONLY: it issues no mutating broker
 * methods. The app-server JSON-RPC stdio child remains the authoritative
 * harness transport.
 */
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import {
  type InvocationEventEnvelope,
  type JsonRpcMessage,
  NdjsonDecoder,
  encodeNdjsonFrame,
} from 'spaces-harness-broker-protocol'
import { postEnvelope } from '../hook-bridge-transport'
import {
  type RendererDurableReadSurface,
  type RendererEventsSinceRequest,
  type RendererEventsSinceResponse,
  createCodexAppServerRendererProjection,
} from './renderer'
import { createStatusLine } from './status-line'
import { createCodexStatusRow } from './transcript'

/** How long a pane resize must settle before the transcript is re-rendered. */
const RESIZE_SETTLE_MS = 120

interface RendererArgs {
  invocationId: string
  observerSocketPath: string
  controlSocketPath: string
  runtimeId?: string | undefined
}

function parseArgs(argv: string[]): RendererArgs {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const invocationId = read('--invocation-id')
  const observerSocketPath = read('--observer-socket')
  const controlSocketPath = read('--control-socket')
  const runtimeId = read('--runtime-id')
  if (
    invocationId === undefined ||
    observerSocketPath === undefined ||
    controlSocketPath === undefined
  ) {
    throw new Error(
      'codex-app-server renderer requires --invocation-id, --observer-socket, and --control-socket'
    )
  }
  return {
    invocationId,
    observerSocketPath,
    controlSocketPath,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  }
}

/**
 * Connect to the broker observer/read socket and expose it as a
 * {@link RendererDurableReadSurface}: `eventsSince` issues the bootstrap request
 * and `observe` delivers live `invocation.event` notifications. NDJSON-framed
 * JSON-RPC, matching the broker's read-method transport.
 */
function connectReadSurface(socketPath: string): {
  surface: RendererDurableReadSurface
  close: () => void
} {
  const decoder = new NdjsonDecoder()
  const liveHandlers = new Set<(event: InvocationEventEnvelope) => void>()
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
  let nextId = 1
  const socket = connect(socketPath)
  socket.setEncoding('utf8')

  function dispatch(message: JsonRpcMessage): void {
    if ('id' in message && message.id !== null && message.id !== undefined) {
      const id = Number(message.id)
      const waiter = pending.get(id)
      if (waiter === undefined) return
      pending.delete(id)
      if ('error' in message && message.error !== undefined) {
        waiter.reject(message.error)
      } else {
        waiter.resolve((message as { result?: unknown }).result)
      }
      return
    }
    if ('method' in message && message.method === 'invocation.event') {
      // The broker/observer wire shape carries the envelope DIRECTLY as `params`
      // (see cli.ts emitEvent / notifyObserverClient and the aspc facade — all
      // four producers emit `params: <envelope>`). Read it directly; tolerate a
      // legacy `{ event }` wrapper defensively so either shape is accepted.
      const params = message.params as
        | (InvocationEventEnvelope & { event?: InvocationEventEnvelope })
        | undefined
      const event = params?.event ?? params
      if (
        event !== undefined &&
        typeof event.seq === 'number' &&
        typeof event.invocationId === 'string'
      ) {
        for (const handler of liveHandlers) handler(event)
      }
    }
  }

  socket.on('data', (chunk: string) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.ok) dispatch(frame.value)
    }
  })

  function request<T>(method: string, params: unknown): Promise<T> {
    const id = nextId++
    return new Promise<T>((resolve, reject) => {
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      socket.write(encodeNdjsonFrame({ jsonrpc: '2.0', id, method, params }))
    })
  }

  return {
    surface: {
      eventsSince: (req: RendererEventsSinceRequest) =>
        request<RendererEventsSinceResponse>('invocation.eventsSince', req),
      observe: (handler) => {
        liveHandlers.add(handler)
        return { close: () => liveHandlers.delete(handler) }
      },
    },
    close: () => socket.destroy(),
  }
}

async function main(): Promise<void> {
  const { invocationId, observerSocketPath, controlSocketPath, runtimeId } = parseArgs(
    process.argv.slice(2)
  )
  const { surface, close } = connectReadSurface(observerSocketPath)
  // The renderer writes into a real tmux pane (a TTY): enable colour unless the
  // operator opted out via NO_COLOR, and wrap/fill to the pane width.
  const isTty = process.stdout.isTTY === true
  const color = process.env['NO_COLOR'] === undefined && isTty
  // A THUNK, not a snapshot (T-06343). This process is exec'd into an HRC-leased
  // pane that is commonly still at tmux's 80-column default, then resized once a
  // client attaches. Reading `columns` once at startup pinned every tinted band
  // to the launch-time width for the life of the pane.
  const width = (): number | undefined => process.stdout.columns

  // The live status row (T-06365). Cursor control is meaningless off a TTY, so the
  // row is TTY-gated independently of colour: NO_COLOR asks for no colour, not for
  // a frozen pane. All transcript output funnels through `writeLine` so the row is
  // always erased before a line is committed and never lands in scrollback.
  const statusRow = createCodexStatusRow({ color, width })
  const statusLine = createStatusLine({
    write: (chunk) => process.stdout.write(chunk),
    renderRow: (frame, elapsedMs) => statusRow.running(frame, elapsedMs),
    enabled: isTty,
  })

  const projection = createCodexAppServerRendererProjection({
    invocationId,
    readSurface: surface,
    sink: (line) => statusLine.writeLine(line),
    onEvent: (event) => statusLine.observe(event),
    color,
    width,
  })
  await projection.start()

  // Re-render the pane when its WIDTH changes (T-06365). Every measure in a row —
  // the prose wrap, the clip, how far the tint was filled — is frozen when the row
  // is committed, and this process is launched into a pane still at tmux's 80-column
  // default that widens the moment a client attaches. Without this, the entire
  // priming block stays wrapped and tinted to ~78 columns for the life of a much
  // wider pane, while everything after the attach reaches the edge.
  //
  // The scrollback is cleared along with the screen and then rebuilt from the same
  // history, so the operator does not end up with two copies of the transcript —
  // one narrow, one wide. Height changes are ignored: nothing is measured against it.
  if (isTty) {
    let lastColumns = process.stdout.columns
    let redrawTimer: ReturnType<typeof setTimeout> | undefined
    process.stdout.on('resize', () => {
      if (process.stdout.columns === lastColumns) return
      lastColumns = process.stdout.columns
      // A drag-resize arrives as a burst; redraw once it settles.
      if (redrawTimer !== undefined) clearTimeout(redrawTimer)
      redrawTimer = setTimeout(() => {
        redrawTimer = undefined
        // Home, clear screen, clear scrollback — then rebuild from the history.
        process.stdout.write('\x1b[H\x1b[2J\x1b[3J')
        statusLine.invalidate()
        projection.redraw()
      }, RESIZE_SETTLE_MS)
    })
  }

  let quitPosted = false
  let exitPosted = false

  async function postRendererExit(exitCode: number | null, signal: string | null): Promise<void> {
    if (quitPosted || exitPosted) return
    exitPosted = true
    await postEnvelope(controlSocketPath, {
      type: 'app-server-renderer.exited',
      invocationId,
      ...(runtimeId !== undefined ? { runtimeId } : {}),
      callbackSocket: controlSocketPath,
      exitCode,
      signal,
    }).catch(() => undefined)
  }

  createInterface({ input: process.stdin }).on('line', (line) => {
    if (line.trim() !== '/quit' || quitPosted) return
    quitPosted = true
    void (async () => {
      await postEnvelope(controlSocketPath, {
        type: 'app-server-renderer.quit',
        invocationId,
        ...(runtimeId !== undefined ? { runtimeId } : {}),
        callbackSocket: controlSocketPath,
        reason: 'prompt_input_exit',
      }).catch(() => undefined)
      statusLine.dispose()
      projection.close()
      close()
      process.exit(0)
    })()
  })

  // Keep the process alive to stream live events into the pane until the pane
  // (or the broker connection) is torn down.
  process.on('SIGINT', () => {
    void postRendererExit(null, 'SIGINT')
    statusLine.dispose()
    projection.close()
    close()
    process.exit(0)
  })
  process.on('beforeExit', (code) => {
    void postRendererExit(code, null)
  })
  // Last line of defence for the cursor. The status row hides it while animating,
  // and a renderer that dies mid-turn by any path we did not enumerate would
  // otherwise leave the operator's pane with no cursor. `dispose` is idempotent and
  // writes synchronously, which is all an `exit` handler may do.
  process.on('exit', () => {
    statusLine.dispose()
  })
}

if (import.meta.main) {
  await main()
}
