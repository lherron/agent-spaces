#!/usr/bin/env bun
/**
 * Muse-serve renderer entry process (T-08590, campaign P-00522).
 *
 * Same launch shape as the codex-app-server renderer entry
 * (--invocation-id/--observer-socket/--control-socket, optional --runtime-id):
 * connects to the broker's read-only observer socket, bootstraps from
 * `invocation.eventsSince`, subscribes to live `invocation.event`, and
 * projects the muse transcript into the leased pane.
 *
 * Presentation/observation ONLY: no mutating broker methods. The serve stdio
 * child remains the authoritative harness transport. Renderer lifecycle
 * envelopes use the muse-serve namespace; no driver control listener consumes
 * them yet (a future muse TUI would).
 */
import { connect } from 'node:net'
import { createInterface } from 'node:readline'
import {
  type InvocationEventEnvelope,
  type JsonRpcMessage,
  NdjsonDecoder,
  encodeNdjsonFrame,
} from 'spaces-harness-broker-protocol'
import { createPaneOutput } from '../codex-app-server/pane-output'
import type {
  RendererDurableReadSurface,
  RendererEventsSinceRequest,
  RendererEventsSinceResponse,
} from '../codex-app-server/renderer'
import { postEnvelope } from '../hook-bridge-transport'
import { createMuseServeRendererProjection } from './renderer'

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
      'muse-serve renderer requires --invocation-id, --observer-socket, and --control-socket'
    )
  }
  return {
    invocationId,
    observerSocketPath,
    controlSocketPath,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
  }
}

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

/** Run the renderer with its flags. */
export async function runMuseRendererEntry(argv: string[]): Promise<void> {
  const { invocationId, observerSocketPath, controlSocketPath, runtimeId } = parseArgs(argv)
  const { surface, close } = connectReadSurface(observerSocketPath)
  // Mirror the codex entry: the renderer writes into a real tmux pane (a
  // TTY), so enable colour unless the operator opted out via NO_COLOR, and
  // wrap/fill to the pane width via a thunk, not a snapshot (T-06343).
  const isTty = process.stdout.isTTY === true
  const color = process.env['NO_COLOR'] === undefined && isTty
  const width = (): number | undefined => process.stdout.columns

  const pane = createPaneOutput({
    write: (chunk) => process.stdout.write(chunk),
    enabled: isTty,
    color,
    width,
    height: () => process.stdout.rows,
  })

  const projection = createMuseServeRendererProjection({
    invocationId,
    readSurface: surface,
    sink: pane.sink,
    onEvent: pane.onEvent,
    verbose: process.env['BROKER_PANE_VERBOSE'] === '1',
    color,
    width,
  })
  await projection.start()
  // The renderer has connected to the durable observer surface and completed
  // its initial replay. This control-envelope acknowledgement is the only
  // authoritative proof that the tmux launch command actually exec'd; pane
  // scroll disappearance is merely a transport hint and must not gate ready.
  await postEnvelope(controlSocketPath, {
    type: 'muse-serve-renderer.started',
    invocationId,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    callbackSocket: controlSocketPath,
  })

  if (isTty) {
    let lastColumns = process.stdout.columns
    let redrawTimer: ReturnType<typeof setTimeout> | undefined
    process.stdout.on('resize', () => {
      if (process.stdout.columns === lastColumns) return
      lastColumns = process.stdout.columns
      if (redrawTimer !== undefined) clearTimeout(redrawTimer)
      redrawTimer = setTimeout(() => {
        redrawTimer = undefined
        process.stdout.write('\x1b[H\x1b[2J\x1b[3J')
        pane.invalidate()
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
      type: 'muse-serve-renderer.exited',
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
        type: 'muse-serve-renderer.quit',
        invocationId,
        ...(runtimeId !== undefined ? { runtimeId } : {}),
        callbackSocket: controlSocketPath,
        reason: 'prompt_input_exit',
      }).catch(() => undefined)
      pane.dispose()
      projection.close()
      close()
      process.exit(0)
    })()
  })

  process.on('SIGINT', () => {
    void postRendererExit(null, 'SIGINT')
    pane.dispose()
    projection.close()
    close()
    process.exit(0)
  })
  process.on('beforeExit', (code) => {
    void postRendererExit(code, null)
  })
  process.on('exit', () => {
    pane.dispose()
  })
}

if (import.meta.main) {
  await runMuseRendererEntry(process.argv.slice(2))
}
