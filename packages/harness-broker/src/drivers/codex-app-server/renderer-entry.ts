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
import {
  type InvocationEventEnvelope,
  type JsonRpcMessage,
  NdjsonDecoder,
  encodeNdjsonFrame,
} from 'spaces-harness-broker-protocol'
import {
  type RendererDurableReadSurface,
  type RendererEventsSinceRequest,
  type RendererEventsSinceResponse,
  createCodexAppServerRendererProjection,
} from './renderer'

interface RendererArgs {
  invocationId: string
  observerSocketPath: string
}

function parseArgs(argv: string[]): RendererArgs {
  const read = (flag: string): string | undefined => {
    const index = argv.indexOf(flag)
    return index === -1 ? undefined : argv[index + 1]
  }
  const invocationId = read('--invocation-id')
  const observerSocketPath = read('--observer-socket')
  if (invocationId === undefined || observerSocketPath === undefined) {
    throw new Error('codex-app-server renderer requires --invocation-id and --observer-socket')
  }
  return { invocationId, observerSocketPath }
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
      const event = (message.params as { event?: InvocationEventEnvelope } | undefined)?.event
      if (event !== undefined) {
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
  const { invocationId, observerSocketPath } = parseArgs(process.argv.slice(2))
  const { surface, close } = connectReadSurface(observerSocketPath)
  const projection = createCodexAppServerRendererProjection({
    invocationId,
    readSurface: surface,
    sink: (line) => process.stdout.write(`${line}\n`),
  })
  await projection.start()
  // Keep the process alive to stream live events into the pane until the pane
  // (or the broker connection) is torn down.
  process.on('SIGINT', () => {
    projection.close()
    close()
    process.exit(0)
  })
}

if (import.meta.main) {
  await main()
}
