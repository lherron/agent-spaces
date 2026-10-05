import { expect } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationRuntimeContext,
  SubmissionOrigin,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../../src/broker'
import { createCodexAppServerDriver } from '../../../src/drivers/codex-app-server/driver'
import type {
  CodexRpcPeer,
  JsonRpcNotification,
  RpcHandlers,
} from '../../../src/drivers/codex-app-server/rpc-client'
import type { TmuxExec } from '../../../src/runtime/tmux'
import { invocationIdFrom } from '../../ids'

export const websocketServers = new Set<ChildProcess>()

export const origin: SubmissionOrigin = {
  principalRef: 'agent:codex-tui-test',
  scopeRef: 'codex-tui-test@agent-spaces',
}

export const lease = (): NonNullable<InvocationRuntimeContext['terminalSurface']> => ({
  kind: 'tmux-pane',
  ownership: 'hrc',
  socketPath: '/tmp/codex-tui-test-tmux.sock',
  sessionId: '$1',
  windowId: '@1',
  paneId: '%1',
  sessionName: 'codex-tui-test',
  windowName: 'main',
  allowedOps: {
    inspect: true,
    sendInput: true,
    sendInterrupt: true,
    capture: true,
  },
})

export const spec = (
  invocationId: string,
  overrides: Partial<Extract<HarnessInvocationSpec['driver'], { kind: 'codex-app-server' }>> = {}
): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(invocationId),
  harness: {
    frontend: 'codex-cli',
    provider: 'openai',
    driver: 'codex-app-server',
  },
  process: {
    command: '/opt/homebrew/bin/codex',
    args: ['app-server'],
    cwd: process.cwd(),
    harnessTransport: { kind: 'jsonrpc-stdio' },
    limits: { startupTimeoutMs: 2_000, turnTimeoutMs: 2_000 },
  },
  interaction: {
    mode: 'interactive',
    turnConcurrency: 'single',
    inputQueue: 'fifo',
  },
  driver: {
    kind: 'codex-app-server',
    presentation: 'codex-tui',
    transport: 'websocket-unix',
    approvalPolicy: 'never',
    ...overrides,
  },
})

function fakeTmux(): { exec: TmuxExec; launched: string[] } {
  const buffers = new Map<string, string>()
  const launched: string[] = []
  let pane = ''
  const exec: TmuxExec = async (argv) => {
    const commandIndex = argv.findIndex((part) =>
      [
        'display-message',
        'load-buffer',
        'paste-buffer',
        'delete-buffer',
        'capture-pane',
        'send-keys',
      ].includes(part)
    )
    const command = argv[commandIndex]
    const args = argv.slice(commandIndex + 1)
    if (command === 'display-message') return { stdout: '$1\t@1\t%1\n', stderr: '' }
    if (command === 'load-buffer') {
      const name = args[args.indexOf('-b') + 1] ?? ''
      const path = args.at(-1) ?? ''
      buffers.set(name, await readFile(path, 'utf8'))
      return { stdout: '', stderr: '' }
    }
    if (command === 'paste-buffer') {
      const name = args[args.indexOf('-b') + 1] ?? ''
      pane = buffers.get(name) ?? ''
      launched.push(pane)
      return { stdout: '', stderr: '' }
    }
    if (command === 'delete-buffer') return { stdout: '', stderr: '' }
    if (command === 'capture-pane') return { stdout: pane, stderr: '' }
    if (command === 'send-keys') {
      pane = ''
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected fake tmux command: ${argv.join(' ')}`)
  }
  return { exec, launched }
}

type RpcRequest = { method: string; params: unknown }

export class FakeCodexRpc implements CodexRpcPeer {
  readonly requests: RpcRequest[] = []
  readonly notifications: RpcRequest[] = []
  handlers: RpcHandlers = {}
  onRequest?: ((method: string, params: unknown) => unknown | Promise<unknown>) | undefined
  threadTurnsListResponse: unknown | (() => unknown) | undefined
  private activeTurnId: string | undefined

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.requests.push({ method, params })
    if (method === 'thread/turns/list') {
      if (this.threadTurnsListResponse !== undefined) {
        return (
          typeof this.threadTurnsListResponse === 'function'
            ? this.threadTurnsListResponse()
            : this.threadTurnsListResponse
        ) as T
      }
      return {
        data:
          this.activeTurnId === undefined ? [] : [{ id: this.activeTurnId, status: 'inProgress' }],
        nextCursor: null,
        backwardsCursor: null,
      } as T
    }
    if (this.onRequest !== undefined) return (await this.onRequest(method, params)) as T
    if (method === 'initialize') return {} as T
    if (method === 'hooks/list') return { data: [] } as T
    if (method === 'thread/start') return { thread: { id: 'thread_test' } } as T
    if (method === 'thread/queue/list') return { data: [] } as T
    throw new Error(`unhandled fake RPC request: ${method}`)
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    this.notifications.push({ method, params })
  }

  close(): void {}

  emit(method: string, params: unknown): void {
    if (method === 'turn/started' || method === 'turn/completed') {
      const record = params as { turn?: { id?: unknown }; turnId?: unknown }
      const turnId = record.turn?.id ?? record.turnId
      if (method === 'turn/started' && typeof turnId === 'string') this.activeTurnId = turnId
      if (method === 'turn/completed' && turnId === this.activeTurnId) {
        this.activeTurnId = undefined
      }
    }
    const message: JsonRpcNotification = { jsonrpc: '2.0', method, params }
    this.handlers.onNotification?.(message, JSON.stringify(message))
  }

  fail(error: Error): void {
    this.handlers.onError?.(error)
  }
}

export function emitTurn(
  rpc: FakeCodexRpc,
  turnId: string,
  options: {
    clientId?: string | null
    firstItem?: 'userMessage' | 'agentMessage'
    terminal?: 'completed' | 'interrupted'
  } = {}
): void {
  rpc.emit('turn/started', {
    threadId: 'thread_test',
    turn: { id: turnId, status: 'inProgress', items: [] },
  })
  const firstItem = options.firstItem ?? 'userMessage'
  rpc.emit('item/started', {
    threadId: 'thread_test',
    turnId,
    item:
      firstItem === 'userMessage'
        ? {
            id: `user_${turnId}`,
            type: 'userMessage',
            clientId: options.clientId ?? null,
            content: [{ type: 'text', text: `prompt ${turnId}` }],
          }
        : { id: `agent_${turnId}`, type: 'agentMessage', text: '' },
  })
  rpc.emit('turn/completed', {
    threadId: 'thread_test',
    turn: {
      id: turnId,
      status: options.terminal ?? 'completed',
      items: [],
    },
  })
}

export function emitUserMessageItem(
  rpc: FakeCodexRpc,
  options: {
    turnId: string
    itemId: string
    clientId?: string | null
    text: string
    threadId?: string
  }
): void {
  rpc.emit('item/started', {
    threadId: options.threadId ?? 'thread_test',
    turnId: options.turnId,
    item: {
      id: options.itemId,
      type: 'userMessage',
      clientId: options.clientId ?? null,
      content: [{ type: 'text', text: options.text }],
    },
  })
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  expect(await predicate(), message).toBe(true)
}

type UnixWebSocketServerMode = 'echo' | 'fragmented-ping' | 'invalid-accept' | 'oversize-frame'

export async function startUnixWebSocketEchoServer(
  socketPath: string,
  mode: UnixWebSocketServerMode = 'echo'
): Promise<{ closedPath: string }> {
  const readyPath = `${socketPath}.ready`
  const closedPath = `${socketPath}.closed`
  const server = spawn(
    'node',
    [
      '--input-type=module',
      '--eval',
      `
        import { createServer } from 'node:http'
        import { writeFile } from 'node:fs/promises'
        import { WebSocketServer } from 'ws'

        const [socketPath, readyPath, closedPath, mode] = process.argv.slice(1)
        const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
        const server = createServer()
        server.on('upgrade', (request, socket, head) => {
          if (request.headers['sec-websocket-extensions'] !== undefined) process.exit(2)
          socket.once('close', () => void writeFile(closedPath, 'closed'))
          if (mode === 'invalid-accept') {
            socket.end(
              'HTTP/1.1 101 Switching Protocols\\r\\n' +
                'Upgrade: websocket\\r\\n' +
                'Connection: Upgrade\\r\\n' +
                'Sec-WebSocket-Accept: invalid\\r\\n\\r\\n'
            )
            return
          }
          wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request))
        })
        wss.on('connection', (ws) => {
          if (mode === 'oversize-frame') {
            setTimeout(() => {
              const frame = Buffer.alloc(10)
              frame[0] = 0x81
              frame[1] = 127
              frame.writeBigUInt64BE(16n * 1024n * 1024n + 1n, 2)
              ws._socket.write(frame)
            }, 20)
            return
          }
          ws.on('message', (raw) => {
            const request = JSON.parse(raw.toString())
            if (request.id !== undefined) {
              const response = JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { ok: true } })
              if (mode === 'fragmented-ping') {
                ws.once('pong', () => {
                  const split = Math.floor(response.length / 2)
                  ws.send(response.slice(0, split), { fin: false })
                  ws.send(response.slice(split))
                })
                ws.ping('probe')
              } else {
                ws.send(response)
              }
            }
          })
        })
        server.listen(socketPath, async () => { await writeFile(readyPath, 'ready') })
        process.on('SIGTERM', () => {
          for (const client of wss.clients) client.terminate()
          server.close(() => process.exit(0))
        })
      `,
      socketPath,
      readyPath,
      closedPath,
      mode,
    ],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] }
  )
  websocketServers.add(server)
  await waitFor(async () => {
    if (server.exitCode !== null) return false
    try {
      return (await readFile(readyPath, 'utf8')) === 'ready'
    } catch {
      return false
    }
  }, 'real Node websocket server should bind its Unix socket')
  if (server.exitCode !== null) {
    throw new Error(`websocket server exited: ${await readFile(readyPath, 'utf8').catch(() => '')}`)
  }
  return { closedPath }
}

export async function setupDriver(
  rpc: FakeCodexRpc,
  invocationId: string,
  driverOverrides: Partial<
    Extract<HarnessInvocationSpec['driver'], { kind: 'codex-app-server' }>
  > = {},
  durableCapture = false
) {
  const events: InvocationEventEnvelope[] = []
  const tmux = fakeTmux()
  // The driver creates several identity-derived UDS paths below this root;
  // macOS limits sockaddr_un paths to 104 bytes, so keep the test root short.
  const socketDir = await mkdtemp(join('/tmp', 'codex-tui-driver-test-'))
  const driver = createCodexAppServerDriver({
    codexTui: {
      tmuxExec: tmux.exec,
      socketDir,
      connect: async (_socketPath, handlers) => {
        rpc.handlers = handlers
        return rpc
      },
    },
  })
  const broker = createBroker({
    drivers: [driver],
    onEvent: (event) => events.push(event),
    ...(durableCapture ? { captureDir: socketDir } : {}),
  })
  const invocationSpec = spec(invocationId, driverOverrides)
  return { broker, driver, events, invocationSpec, socketDir, tmux }
}
