import { existsSync } from 'node:fs'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { type Socket, connect, createServer } from 'node:net'
import { dirname } from 'node:path'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  HarnessInvocationSpec,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDispatchRequest,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationStartRequest,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import {
  BrokerErrorCode,
  validateCommand,
  validateInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { Broker, BrokerAttachIdentity } from './broker'
import { createDefaultBroker } from './default-broker'
import { runClaudeHookBridgeCli } from './drivers/claude-code-tmux/hook-bridge'
import { runCodexHookBridgeCli } from './drivers/codex-cli-tmux/hook-bridge'
import { BrokerError } from './errors'
import { createEventLedger } from './event-ledger'
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
 * it (the durability difference from the stdio child). Phase C1 adds the
 * durable event ledger, attach identity gate, latest-valid-attach-wins fencing,
 * and the eventsSince/ackEvents/snapshot replay surface.
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

  // Durability wiring (Phase C1): on-disk event ledger + attach identity gate.
  const ledgerPath = readFlag(args, '--event-ledger')
  const runtimeId = readFlag(args, '--runtime-id')
  const hostSessionId = readFlag(args, '--host-session-id')
  const generationRaw = readFlag(args, '--generation')
  const attachTokenFile = readFlag(args, '--attach-token-file')

  const eventLedger = ledgerPath !== undefined ? createEventLedger({ path: ledgerPath }) : undefined

  let attachIdentity: BrokerAttachIdentity | undefined
  if (
    runtimeId !== undefined &&
    hostSessionId !== undefined &&
    generationRaw !== undefined &&
    attachTokenFile !== undefined
  ) {
    attachIdentity = {
      runtimeId,
      hostSessionId,
      generation: Number(generationRaw),
      attachToken: (await readFile(attachTokenFile, 'utf8')).trim(),
    }
  }

  const brokerInstanceId = `broker_${process.pid}`

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })

  // Hazard (b): conservative stale-socket cleanup — only unlink a socket node
  // that NO live listener answers; never steal a socket a peer accepts.
  await reclaimStaleSocket(socketPath)

  // The live controller channel: the most recently connected — and ultimately
  // the attached/fenced — controller. Event notifications and broker→client
  // permission requests route here.
  let liveServer: ProtocolServer | undefined
  let liveSocket: Socket | undefined
  // Fencing gate: set on a successful attach; only this controller may ack.
  let activeController: { server: ProtocolServer; socket: Socket; instanceId: string } | undefined

  function emitEvent(event: InvocationEventEnvelope): void {
    if (!liveServer) return
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'invocation.event',
      params: event,
    }
    liveServer.notify(notification)
  }

  const broker = createDefaultBroker(
    emitEvent,
    (params) => {
      if (!liveServer) {
        return Promise.reject(new Error('No controller connected for permission request'))
      }
      return liveServer.request<PermissionDecision>('invocation.permission.request', params)
    },
    {
      advertisedTransports: ['stdio-jsonrpc-ndjson', 'unix-jsonrpc-ndjson'],
      advertiseAttachReplay: true,
      brokerInstanceId,
      ...(eventLedger !== undefined ? { eventLedger } : {}),
      ...(attachIdentity !== undefined ? { attachIdentity } : {}),
    }
  )

  // Send a terminal control error to the fenced controller, then close it. The
  // client transport surfaces `control.fenced` as a ControllerFenced close so a
  // subsequent ackEvents on the dead socket rejects with that code.
  function fenceController(prev: { server: ProtocolServer; socket: Socket }): void {
    try {
      prev.server.notify({
        jsonrpc: '2.0',
        method: 'control.fenced',
        params: {
          code: BrokerErrorCode.ControllerFenced,
          message: 'Controller fenced by a newer attach',
        },
      })
    } catch {
      // Best-effort: the socket may already be gone.
    }
    prev.socket.end()
  }

  async function handleAttach(
    params: BrokerAttachRequest,
    server: ProtocolServer,
    socket: Socket
  ): Promise<BrokerAttachResponse> {
    // broker.attach validates identity/token/correlation and throws
    // AttachRejected on any mismatch — validate BEFORE fencing the incumbent.
    const response = await broker.attach(params)
    const previous = activeController
    activeController = { server, socket, instanceId: params.controllerInstanceId }
    liveServer = server
    liveSocket = socket
    if (previous && previous.socket !== socket) {
      fenceController(previous)
    }
    return response
  }

  async function handleAckEvents(
    params: InvocationAckEventsRequest
  ): Promise<InvocationAckEventsResponse> {
    if (activeController && activeController.instanceId !== params.controllerInstanceId) {
      throw new BrokerError(
        BrokerErrorCode.ControllerFenced,
        'Controller has been fenced by a newer attach',
        { controllerInstanceId: params.controllerInstanceId }
      )
    }
    return broker.ackEvents(params)
  }

  function registerDurabilityMethods(server: ProtocolServer, socket: Socket): void {
    server.register('broker.attach', async ({ params }) =>
      handleAttach(params as BrokerAttachRequest, server, socket)
    )
    server.register('invocation.snapshot', async ({ params }) =>
      broker.snapshot(params as Parameters<typeof broker.snapshot>[0])
    )
    server.register('invocation.eventsSince', async ({ params }) =>
      broker.eventsSince(params as Parameters<typeof broker.eventsSince>[0])
    )
    server.register('invocation.ackEvents', async ({ params }) =>
      handleAckEvents(params as InvocationAckEventsRequest)
    )
  }

  const netServer = createServer((socket) => {
    const server = createProtocolServer({
      stdin: socket,
      stdout: socket,
      stderr: process.stderr,
    })
    registerBrokerMethods(server, broker)
    registerDurabilityMethods(server, socket)
    void server.start()

    // Latest connection becomes the live notification target; a previously
    // attached controller is only fenced when a new controller attaches.
    liveServer = server
    liveSocket = socket

    const cleanup = (): void => {
      if (liveSocket === socket) {
        liveSocket = undefined
        liveServer = undefined
      }
      if (activeController && activeController.socket === socket) {
        activeController = undefined
      }
      void server.close()
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
