import { mkdir, unlink } from 'node:fs/promises'
import { type Socket, createServer } from 'node:net'
import { dirname, join } from 'node:path'
import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationEventEnvelope,
  JsonRpcNotification,
  PermissionDecision,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import type { Broker, BrokerAttachIdentity } from './broker'
import { registerBrokerMethods, registerValidatedMethods } from './broker-methods'
import type { RunBrokerCliOptions } from './cli'
import { createDefaultBroker } from './default-broker'
import { BrokerError } from './errors'
import { createEventLedger } from './event-ledger'
import { type BrokerObserverSocket, startBrokerObserverSocket } from './observer-socket'
import { type ProtocolServer, createProtocolServer } from './protocol-server'
import { assertSocketPathWithinBudget, reclaimStaleSocket } from './socket-path'

/**
 * Long-lived broker over a Unix domain socket. The broker process owns a single
 * `net.Server`; controllers connect and disconnect freely without terminating
 * it (the durability difference from the stdio child). Phase C1 adds the
 * durable event ledger, attach identity gate, latest-valid-attach-wins fencing,
 * and the eventsSince/ackEvents/snapshot replay surface.
 */
export type ServeUnixBrokerOptions = {
  socketPath: string
  cliOptions: RunBrokerCliOptions
  ledgerPath?: string | undefined
  observerSocketPath?: string | undefined
  observerMode?: string | undefined
  participantBootstrap: boolean
  attachIdentity?: BrokerAttachIdentity | undefined
  onServerError?: ((error: Error) => void) | undefined
}

export type ServedUnixBroker = {
  broker: Broker
  socketPath: string
  close: () => Promise<void>
}

/**
 * Start the durable unix broker listener in this process with the given
 * posture. Shared by `run --transport unix` and `desktop-join`, which serves the
 * same participant bootstrap posture in-process (T-08594): the ONLY difference
 * is who owns the process lifetime. Resolves once the socket is bound; rejects
 * when the bind fails. Post-bind server errors go to `onServerError`.
 */
export async function serveUnixBroker(
  serveOptions: ServeUnixBrokerOptions
): Promise<ServedUnixBroker> {
  const {
    socketPath,
    cliOptions: options,
    ledgerPath,
    observerSocketPath,
    observerMode = 'observe',
    participantBootstrap,
    attachIdentity,
    onServerError,
  } = serveOptions
  if (observerSocketPath !== undefined && observerMode !== 'observe') {
    throw new Error(
      `Unsupported observer mode ${JSON.stringify(observerMode)}; only "observe" is implemented`
    )
  }

  // Hazard (a): refuse over-long socket paths up front with a readable error
  // instead of surfacing a low-level sockaddr_un bind failure.
  assertSocketPathWithinBudget(socketPath)

  // Durability wiring (Phase C1): on-disk event ledger + attach identity gate.
  const eventLedger = ledgerPath !== undefined ? createEventLedger({ path: ledgerPath }) : undefined

  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })

  // Hazard (b): conservative stale-socket cleanup — only unlink a socket node
  // that NO live listener answers; never steal a socket a peer accepts.
  await reclaimStaleSocket(socketPath)

  // The live controller channel: the most recently connected — and ultimately
  // the attached/fenced — controller. Event notifications and broker→client
  // permission requests route here.
  let liveServer: ProtocolServer | undefined
  // `liveSocket` is NOT vestigial despite never having its value dereferenced:
  // it is the cleanup identity key. Its sole read is the `liveSocket === socket`
  // guard in the connection handler's cleanup() below, which clears `liveServer`
  // ONLY when the closing socket is the current live one (a stale connection
  // closing after a newer one became live must not wipe the live target). It is
  // written in lockstep with `liveServer` (here on attach, and on each connect),
  // and tracks a DIFFERENT lifetime than `activeController` (which is set only on
  // a successful fenced attach), so it cannot be folded into the fencing record.
  let liveSocket: Socket | undefined
  // Fencing gate: set on a successful attach; only this controller may ack.
  let activeController: { server: ProtocolServer; socket: Socket; instanceId: string } | undefined
  let observer: BrokerObserverSocket | undefined

  function emitEvent(event: InvocationEventEnvelope): void {
    observer?.notify(event)
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
      // brokerInstanceId intentionally omitted: createBroker defaults it to
      // `broker_${process.pid}`, computed in this same process (identical value).
      // T-01794 Phase D: runtime-scoped hook IPC dir derived from this durable
      // broker's --socket parent, so its tmux drivers bind per-invocation hook
      // sockets under it (never the global tmpdir socket two runtimes share).
      hookIpcDir: join(dirname(socketPath), 'hooks'),
      additionalDrivers: options.additionalDrivers,
      releaseIdentity: options.releaseIdentity,
      rendererLauncher: options.rendererLauncher,
      codexTuiLauncher: options.codexTuiLauncher,
      tmuxHelperLauncher: options.tmuxHelperLauncher,
      ...(eventLedger !== undefined ? { eventLedger } : {}),
      // Raw ingress journal + disposition index live beside the normalized
      // ledger (§7.1, §8.1). Without a ledger path capture stays in memory,
      // exactly as the ledger itself does.
      ...(ledgerPath !== undefined ? { captureDir: dirname(ledgerPath) } : {}),
      ...(attachIdentity !== undefined ? { attachIdentity } : {}),
      // Durable start-attempt receipts live beside the ledger they explain.
      ...(ledgerPath !== undefined ? { receiptDir: dirname(ledgerPath) } : {}),
      ...(participantBootstrap ? { participantBootstrap: true } : {}),
    }
  )

  if (observerSocketPath !== undefined) {
    observer = await startBrokerObserverSocket({ socketPath: observerSocketPath, broker })
  }

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
    server.register('invocation.permission.respond', async ({ params }) =>
      broker.permissionRespond(params as Parameters<typeof broker.permissionRespond>[0])
    )
    server.register('invocation.capture.release', async ({ params }) =>
      broker.captureRelease(params as Parameters<typeof broker.captureRelease>[0])
    )
    // Participant bootstrap + resident-invocation establishment (C.5/C.5.1).
    // Registered HERE, with `broker.attach`, because they are the durable
    // runtime's establishment surface: the stdio child never attaches, has no
    // durable ledger, and therefore has no durable attempt to make retry-safe.
    registerValidatedMethods(server, {
      'broker.installIdentity': {
        handle: (p) => broker.installIdentity(p as Parameters<typeof broker.installIdentity>[0]),
      },
      'broker.ensureInvocation': {
        handle: (p) => broker.ensureInvocation(p as Parameters<typeof broker.ensureInvocation>[0]),
      },
    })
  }

  const netServer = createServer((socket) => {
    const server = createProtocolServer({
      stdin: socket,
      stdout: socket,
      stderr: process.stderr,
    })
    registerBrokerMethods(server, broker, {
      experimentalObserverEnabled: observerSocketPath !== undefined,
    })
    registerDurabilityMethods(server, socket)
    void server.start()

    // Latest connection becomes the live notification target; a previously
    // attached controller is only fenced when a new controller attaches.
    liveServer = server
    liveSocket = socket

    const cleanup = (): void => {
      // Identity guard: only clear the live target when THIS connection's socket
      // is the current one. A stale connection closing after a newer one became
      // live must not wipe the live server.
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

  const close = async (): Promise<void> => {
    netServer.close()
    // Release the durable consumer-state index handle. Its contents are already
    // fsync'd per write (synchronous=FULL), so a `kill -9` that skips this loses
    // nothing — this only avoids leaving a WAL open on a clean exit.
    eventLedger?.close()
    await Promise.all([observer?.close(), unlink(socketPath).catch(() => {})])
  }

  const reportServerError =
    onServerError ??
    ((err: Error): void => {
      process.stderr.write(`Broker unix server error: ${err.message}\n`)
      void (observer?.close() ?? Promise.resolve()).finally(() => process.exit(1))
    })
  netServer.on('error', reportServerError)

  await new Promise<void>((resolve, reject) => {
    netServer.once('error', reject)
    netServer.once('listening', () => {
      netServer.removeListener('error', reject)
      resolve()
    })
    netServer.listen(socketPath)
  })

  return { broker, socketPath, close }
}
