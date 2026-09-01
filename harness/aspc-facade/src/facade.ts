/**
 * The co-hosted `aspc-facade` JSON-RPC server (T-07314).
 *
 * Composition only: it owns the transport (from `spaces-harness-broker`), binds
 * the compile plane through `spaces-aspc`'s transport-injected registration
 * seam, then adds the routes that require a live broker — `aspc.compileAndStart`,
 * `broker.*` and `invocation.*` — plus the server->client `invocation.event`
 * notification and `invocation.permission.request` callback.
 */
import type { Readable, Writable } from 'node:stream'
import type { AspcCompiler, AspcServiceOptions } from 'spaces-aspc'
import { JSONRPC_VERSION, registerAspcCompileMethods, registerAspcMethod } from 'spaces-aspc'
import { validateAspcCompileAndStartRequest } from 'spaces-aspc-protocol'
import { createDefaultBroker, createProtocolServer } from 'spaces-harness-broker'
import type { Broker, ProtocolServer } from 'spaces-harness-broker'
import type {
  InvocationDispatchRequest,
  InvocationEventEnvelope,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import { validateCommand } from 'spaces-harness-broker-protocol'
import { createCohostedAspcService, startFromDispatch } from './service.js'

export interface AspcFacadeOptions
  extends Pick<
    AspcServiceOptions,
    | 'agentsRoot'
    | 'resolveProjectRoot'
    | 'environment'
    | 'now'
    | 'serviceProbeResponses'
    | 'scaffoldPackets'
  > {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  broker?: Broker | undefined
  compiler?: AspcCompiler | undefined
}

const ASPC_COMPILE_AND_START_METHOD = 'aspc.compileAndStart'

const BROKER_METHODS = {
  hello: 'broker.hello',
  health: 'broker.health',
  start: 'invocation.start',
  input: 'invocation.input',
  interrupt: 'invocation.interrupt',
  stop: 'invocation.stop',
  status: 'invocation.status',
  dispose: 'invocation.dispose',
  steer: 'submission.steer',
  enqueue: 'submission.enqueue',
  invoke: 'submission.invoke',
  preempt: 'submission.preempt',
  queueList: 'queue.list',
  queueJump: 'queue.jump',
  queueCancel: 'queue.cancel',
  turnManifest: 'turn.manifest',
  seatProbe: 'seat.probe',
} as const

export function createAspcFacadeServer(options: AspcFacadeOptions): ProtocolServer {
  const server = createProtocolServer({
    stdin: options.stdin,
    stdout: options.stdout,
    stderr: options.stderr,
  })

  function emitEvent(event: InvocationEventEnvelope): void {
    const notification: JsonRpcNotification = {
      jsonrpc: JSONRPC_VERSION,
      method: 'invocation.event',
      params: event,
    }
    server.notify(notification)
  }

  const broker =
    options.broker ??
    createDefaultBroker(
      (event) => emitEvent(event),
      (params) => server.request<PermissionDecision>('invocation.permission.request', params)
    )
  const aspc = createCohostedAspcService({
    broker,
    ...(options.compiler !== undefined ? { compiler: options.compiler } : {}),
    ...(options.agentsRoot !== undefined ? { agentsRoot: options.agentsRoot } : {}),
    ...(options.resolveProjectRoot !== undefined
      ? { resolveProjectRoot: options.resolveProjectRoot }
      : {}),
    ...(options.environment !== undefined ? { environment: options.environment } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.serviceProbeResponses !== undefined
      ? { serviceProbeResponses: options.serviceProbeResponses }
      : {}),
    ...(options.scaffoldPackets !== undefined ? { scaffoldPackets: options.scaffoldPackets } : {}),
  })

  registerAspcCompileMethods(server, { service: aspc })
  registerAspcMethod(
    server,
    ASPC_COMPILE_AND_START_METHOD,
    validateAspcCompileAndStartRequest,
    (req) => aspc.compileAndStart(req)
  )

  registerBrokerMethods(server, broker)
  return server
}

export function runAspcFacadeStdio(
  options: Omit<AspcFacadeOptions, 'stdin' | 'stdout' | 'stderr'> = {}
): void {
  const server = createAspcFacadeServer({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    ...options,
  })

  void server.start()

  process.stdin.on('end', () => {
    void server.close().then(() => {
      process.exit(0)
    })
  })
}

/**
 * Table of broker RPC routes. Each entry validates its params through the
 * broker protocol seam and forwards to the matching `Broker` method, so adding
 * a route is one row rather than another copy-pasted `server.register` block.
 */
function brokerMethodTable(broker: Broker): ReadonlyArray<{
  method: string
  invoke: (params: unknown) => Promise<unknown>
}> {
  return [
    {
      method: BROKER_METHODS.hello,
      invoke: (params) => broker.hello(params as Parameters<typeof broker.hello>[0]),
    },
    {
      method: BROKER_METHODS.health,
      invoke: (params) => broker.health((params ?? {}) as Parameters<typeof broker.health>[0]),
    },
    {
      method: BROKER_METHODS.start,
      invoke: (params) => startFromDispatch(broker, params as InvocationDispatchRequest),
    },
    {
      method: BROKER_METHODS.input,
      invoke: (params) => broker.input(params as Parameters<typeof broker.input>[0]),
    },
    {
      method: BROKER_METHODS.interrupt,
      invoke: (params) => broker.interrupt(params as Parameters<typeof broker.interrupt>[0]),
    },
    {
      method: BROKER_METHODS.stop,
      invoke: (params) => broker.stop(params as Parameters<typeof broker.stop>[0]),
    },
    {
      method: BROKER_METHODS.status,
      invoke: (params) => broker.status(params as Parameters<typeof broker.status>[0]),
    },
    {
      method: BROKER_METHODS.dispose,
      invoke: (params) => broker.dispose(params as Parameters<typeof broker.dispose>[0]),
    },
    {
      method: BROKER_METHODS.steer,
      invoke: (params) => broker.steer(params as Parameters<typeof broker.steer>[0]),
    },
    {
      method: BROKER_METHODS.enqueue,
      invoke: (params) => broker.enqueue(params as Parameters<typeof broker.enqueue>[0]),
    },
    {
      method: BROKER_METHODS.invoke,
      invoke: (params) => broker.invoke(params as Parameters<typeof broker.invoke>[0]),
    },
    {
      method: BROKER_METHODS.preempt,
      invoke: (params) => broker.preempt(params as Parameters<typeof broker.preempt>[0]),
    },
    {
      method: BROKER_METHODS.queueList,
      invoke: (params) => broker.queueList(params as Parameters<typeof broker.queueList>[0]),
    },
    {
      method: BROKER_METHODS.queueJump,
      invoke: (params) => broker.queueJump(params as Parameters<typeof broker.queueJump>[0]),
    },
    {
      method: BROKER_METHODS.queueCancel,
      invoke: (params) => broker.queueCancel(params as Parameters<typeof broker.queueCancel>[0]),
    },
    {
      method: BROKER_METHODS.turnManifest,
      invoke: (params) => broker.turnManifest(params as Parameters<typeof broker.turnManifest>[0]),
    },
    {
      method: BROKER_METHODS.seatProbe,
      invoke: (params) => broker.seatProbe(params as Parameters<typeof broker.seatProbe>[0]),
    },
  ]
}

function registerBrokerMethods(server: ProtocolServer, broker: Broker): void {
  for (const { method, invoke } of brokerMethodTable(broker)) {
    server.register(method, async ({ id, params }) => {
      validateCommand({ jsonrpc: JSONRPC_VERSION, id, method, params })
      return invoke(params)
    })
  }
}
