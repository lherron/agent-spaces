import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { type Socket, connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationDispatchRequest,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationStartRequest,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import { validateCommand, validateInvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { Broker } from './broker'
import { createDefaultBroker } from './default-broker'
import { runClaudeHookBridgeCli } from './drivers/claude-code-tmux/hook-bridge'
import { runCodexHookBridgeCli } from './drivers/codex-cli-tmux/hook-bridge'
import { type ProtocolServer, createProtocolServer } from './protocol-server'
import { assertSocketPathWithinBudget } from './socket-path'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (command === 'run') {
    const transportIdx = args.indexOf('--transport')
    const transport = transportIdx !== -1 ? args[transportIdx + 1] : undefined

    if (transport === 'stdio') {
      runStdio()
    } else if (transport === 'unix') {
      await runUnix(args)
    } else {
      process.stderr.write(`Unknown or missing transport: ${transport ?? '(none)'}\n`)
      process.exit(1)
    }
  } else if (command === 'drivers') {
    const json = args.includes('--json')
    const broker = createDefaultBroker()
    const hello = await broker.hello({
      clientInfo: { name: 'harness-broker-cli' },
      protocolVersions: ['harness-broker/0.1'],
    })
    if (json) {
      process.stdout.write(`${JSON.stringify(hello.drivers, null, 2)}\n`)
    } else {
      for (const driver of hello.drivers) {
        process.stdout.write(`${driver.kind}\t${driver.available ? 'available' : 'unavailable'}\n`)
      }
    }
  } else if (command === 'claude-hook') {
    await runClaudeHookBridgeCli(args.slice(1))
  } else if (command === 'codex-hook') {
    await runCodexHookBridgeCli(args.slice(1))
  } else if (command === 'run-once') {
    await runOnce(args.slice(1))
  } else if (command === 'validate-start-request') {
    await validateStartRequestCommand(args.slice(1))
  } else {
    process.stderr.write(
      `Unknown command: ${command ?? '(none)'}\nUsage: harness-broker run --transport stdio\n`
    )
    process.exit(1)
  }
}

function runStdio(): void {
  const server = createProtocolServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  })

  function emitEvent(event: InvocationEventEnvelope): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    server.notify(notification)
  }

  // Wire ask-client permission decisions to the broker→client request transport.
  const broker = createDefaultBroker(emitEvent, (params) =>
    server.request<PermissionDecision>('invocation.permission.request', params)
  )

  registerBrokerMethods(server, broker)

  void server.start()

  process.stdin.on('end', () => {
    void server.close().then(() => {
      process.exit(0)
    })
  })
}

/**
 * Register the v1 broker JSON-RPC methods on a protocol server. Shared by the
 * stdio and unix transport entry points so both expose identical surfaces.
 */
function registerBrokerMethods(server: ProtocolServer, broker: Broker): void {
  function validateParams(method: string, id: string | number | null, params: unknown): void {
    validateCommand({ jsonrpc: '2.0', id, method, params })
  }

  server.register('broker.hello', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.hello(params as Parameters<typeof broker.hello>[0])
  })

  server.register('broker.health', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.health((params ?? {}) as Parameters<typeof broker.health>[0])
  })

  server.register('invocation.start', async ({ id, method, params }) => {
    // validateCommand validates the full InvocationDispatchRequest envelope
    // (including dispatchEnv key-class + lockedEnv-shadow rules) before dispatch.
    validateParams(method, id, params)
    const dispatch = params as InvocationDispatchRequest
    return broker.start(
      dispatch.startRequest,
      dispatch.dispatchEnv,
      dispatch.runtime,
      dispatch.lifecyclePolicy
    )
  })

  server.register('invocation.input', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.input(params as Parameters<typeof broker.input>[0])
  })

  server.register('invocation.interrupt', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.interrupt(params as Parameters<typeof broker.interrupt>[0])
  })

  server.register('invocation.stop', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.stop(params as Parameters<typeof broker.stop>[0])
  })

  server.register('invocation.status', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.status(params as Parameters<typeof broker.status>[0])
  })

  server.register('invocation.dispose', async ({ id, method, params }) => {
    validateParams(method, id, params)
    return broker.dispose(params as Parameters<typeof broker.dispose>[0])
  })
}

/**
 * Long-lived broker over a Unix domain socket. The broker process owns a single
 * `net.Server`; controllers connect and disconnect freely without terminating
 * it (the durability difference from the stdio child). Phase B wires the
 * transport + lifecycle only — durable ledger/attach/fencing land in Phase C.
 */
async function runUnix(args: string[]): Promise<void> {
  const socketPath = readFlag(args, '--socket')
  if (!socketPath) {
    process.stderr.write('Usage: harness-broker run --transport unix --socket <path>\n')
    process.exit(1)
  }

  // Hazard (a): refuse over-long socket paths up front with a readable error
  // instead of surfacing a low-level sockaddr_un bind failure.
  try {
    assertSocketPathWithinBudget(socketPath)
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }

  // Flags accepted for forward-compat with Phase C durability (--runtime-id,
  // --host-session-id, --generation, --attach-token-file, --event-ledger,
  // --log-file). Phase B does not act on them beyond accepting them.

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })

  // Hazard (b): conservative stale-socket cleanup — only unlink a socket node
  // that NO live listener answers; never steal a socket a peer accepts.
  await reclaimStaleSocket(socketPath)

  let activeServer: ProtocolServer | undefined
  let activeSocket: Socket | undefined

  function emitEvent(event: InvocationEventEnvelope): void {
    if (!activeServer) return
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    activeServer.notify(notification)
  }

  const broker = createDefaultBroker(
    emitEvent,
    (params) => {
      if (!activeServer) {
        return Promise.reject(new Error('No controller connected for permission request'))
      }
      return activeServer.request<PermissionDecision>('invocation.permission.request', params)
    },
    {
      advertisedTransports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
      advertiseAttachReplay: true,
    }
  )

  const netServer = createServer((socket) => {
    // Hazard (c): pre-fencing — accept only ONE controller connection at a
    // time so an extra socket can never observe notifications/permissions.
    if (activeSocket) {
      socket.destroy()
      return
    }
    activeSocket = socket
    const server = createProtocolServer({
      stdin: socket,
      stdout: socket,
      stderr: process.stderr,
    })
    activeServer = server
    registerBrokerMethods(server, broker)
    void server.start()

    const cleanup = (): void => {
      if (activeSocket === socket) {
        activeSocket = undefined
        activeServer = undefined
        void server.close()
      }
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
  })

  const shutdown = (): void => {
    netServer.close()
    void unlink(socketPath)
      .catch(() => {})
      .then(() => {
        process.exit(0)
      })
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  netServer.on('error', (err) => {
    process.stderr.write(
      `Broker unix server error: ${err instanceof Error ? err.message : String(err)}\n`
    )
    process.exit(1)
  })

  netServer.listen(socketPath)
}

/** Probe an existing socket node and unlink it only if no live listener answers. */
async function reclaimStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return
  }
  if (await probeSocketAlive(socketPath)) {
    process.stderr.write(`Broker socket already in use by a live listener: ${socketPath}\n`)
    process.exit(1)
  }
  await unlink(socketPath).catch(() => {})
}

function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ path: socketPath })
    const done = (alive: boolean): void => {
      probe.destroy()
      resolve(alive)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}

async function runOnce(args: string[]): Promise<void> {
  let request: InvocationStartRequest
  try {
    request = await loadStartRequest(args)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exit(1)
  }

  let resolveTurnDone: (() => void) | undefined
  const turnDone = new Promise<void>((resolve) => {
    resolveTurnDone = resolve
  })

  const broker = createDefaultBroker((event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`)
    if (
      event.type === 'turn.completed' ||
      event.type === 'turn.failed' ||
      event.type === 'turn.interrupted'
    ) {
      resolveTurnDone?.()
    }
  })

  // Same path the BrokerClient drives: a single InvocationStartRequest with its
  // initialInput carries the first turn — no separate invocation.input call.
  const start = await broker.start(request)
  await turnDone
  await broker.stop({
    invocationId: start.invocationId,
    reason: 'run-once complete',
    graceMs: request.spec.process.limits?.stopGraceMs ?? 500,
  })
  await broker.dispose({ invocationId: start.invocationId })
}

/**
 * Resolve a single InvocationStartRequest from CLI flags. `--start-request`
 * (the ASP compiler's output shape) is preferred; `--spec`/`--input` is kept
 * for backward compatibility and folded into the same request shape. The
 * request is validated before it reaches the broker.
 */
async function loadStartRequest(args: string[]): Promise<InvocationStartRequest> {
  const startRequestPath = readFlag(args, '--start-request')
  if (startRequestPath) {
    const raw = (await Bun.file(startRequestPath).json()) as unknown
    return validateInvocationStartRequest(raw)
  }

  const specPath = readFlag(args, '--spec')
  const inputPath = readFlag(args, '--input')
  if (specPath && inputPath) {
    const spec = (await Bun.file(specPath).json()) as HarnessInvocationSpec
    const initialInput = (await Bun.file(inputPath).json()) as InvocationInput
    return validateInvocationStartRequest({ spec, initialInput })
  }

  throw new Error(
    'Usage: harness-broker run-once (--start-request start-request.json | --spec invocation.json --input input.json)'
  )
}

async function validateStartRequestCommand(args: string[]): Promise<void> {
  const filePath = readFlag(args, '--file')
  if (!filePath) {
    process.stderr.write('Usage: harness-broker validate-start-request --file start-request.json\n')
    process.exit(1)
  }

  try {
    const raw = (await Bun.file(filePath).json()) as unknown
    validateInvocationStartRequest(raw)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exit(1)
  }

  process.stdout.write('valid\n')
}

function formatError(err: unknown): string {
  if (err && typeof err === 'object' && 'issues' in err) {
    const message = err instanceof Error ? err.message : 'Validation failed'
    return `${message}\n${JSON.stringify((err as { issues: unknown }).issues, null, 2)}`
  }
  return err instanceof Error ? err.message : String(err)
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

void main()
