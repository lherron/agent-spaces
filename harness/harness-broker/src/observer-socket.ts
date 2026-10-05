import { existsSync, unlinkSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import { type Socket, createServer } from 'node:net'
import { dirname } from 'node:path'
import type { InvocationEventEnvelope, JsonRpcNotification } from 'spaces-harness-broker-protocol'
import type { Broker } from './broker'
import { registerBrokerObserverMethods } from './broker-methods'
import { type ProtocolServer, createProtocolServer } from './protocol-server'
import { assertSocketPathWithinBudget, reclaimStaleSocket } from './socket-path'

export interface BrokerObserverSocket {
  notify(event: InvocationEventEnvelope): void
  close(): Promise<void>
}

interface ObserverSubscription {
  cursor: number
  queued: InvocationEventEnvelope[] | undefined
}

interface ObserverClient {
  server: ProtocolServer
  subscriptions: Map<string, ObserverSubscription>
}

/**
 * The experimental read-only observer socket (renderers attach here). Each
 * client's `eventsSince` opens a subscription that queues live events until the
 * catch-up response is sent, so a client never sees a gap or a duplicate.
 */
export async function startBrokerObserverSocket(options: {
  socketPath: string
  broker: Broker
}): Promise<BrokerObserverSocket> {
  const { socketPath, broker } = options
  assertSocketPathWithinBudget(socketPath)
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 })
  await reclaimStaleSocket(socketPath)

  const observers = new Set<ObserverClient>()
  const sockets = new Set<Socket>()
  const netServer = createServer((socket) => {
    sockets.add(socket)
    const observer = createProtocolServer({
      stdin: socket,
      stdout: socket,
      stderr: process.stderr,
    })
    const client: ObserverClient = {
      server: observer,
      subscriptions: new Map(),
    }
    const observerBroker: Broker = {
      ...broker,
      async eventsSince(req) {
        const subscription: ObserverSubscription = { cursor: req.afterSeq, queued: [] }
        client.subscriptions.set(req.invocationId, subscription)
        try {
          const response = await broker.eventsSince(req)
          subscription.cursor = response.currentSeq
          setImmediate(() => {
            const current = client.subscriptions.get(req.invocationId)
            if (current !== subscription || current.queued === undefined) return
            const queued = current.queued
            current.queued = undefined
            for (const event of queued) {
              notifyObserverClient(client, event)
            }
          })
          return response
        } catch (err) {
          client.subscriptions.delete(req.invocationId)
          throw err
        }
      },
    }
    registerBrokerObserverMethods(observer, observerBroker)
    observers.add(client)
    void observer.start()

    const cleanup = (): void => {
      sockets.delete(socket)
      observers.delete(client)
      void observer.close()
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      netServer.removeListener('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      netServer.removeListener('error', onError)
      resolve()
    }
    netServer.once('error', onError)
    netServer.once('listening', onListening)
    netServer.listen(socketPath)
  })

  netServer.on('error', (err) => {
    process.stderr.write(
      `Broker observer socket error: ${err instanceof Error ? err.message : String(err)}\n`
    )
  })

  const unlinkSocket = (): Promise<void> => unlink(socketPath).catch(() => {})
  const cleanupSocketOnExit = (): void => {
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath)
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
  let closed = false
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed) {
        resolve()
        return
      }
      closed = true
      process.removeListener('exit', cleanupSocketOnExit)
      for (const observer of observers) {
        void observer.server.close()
      }
      observers.clear()
      for (const socket of sockets) {
        socket.end()
        socket.destroy()
      }
      sockets.clear()
      netServer.close(() => {
        void unlinkSocket().then(() => resolve())
      })
    })

  process.once('exit', cleanupSocketOnExit)

  return {
    notify(event: InvocationEventEnvelope): void {
      for (const observer of observers) {
        notifyObserverClient(observer, event)
      }
    },
    close,
  }
}

function notifyObserverClient(client: ObserverClient, event: InvocationEventEnvelope): void {
  const subscription = client.subscriptions.get(event.invocationId)
  if (subscription === undefined || event.seq <= subscription.cursor) return
  if (subscription.queued !== undefined) {
    subscription.queued.push(event)
    return
  }
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method: 'invocation.event',
    params: eventForObserverNotification(event),
  }
  client.server.notify(notification)
  subscription.cursor = event.seq
}

function eventForObserverNotification(event: InvocationEventEnvelope): InvocationEventEnvelope {
  if (event.type !== 'turn.completed') return event
  if (event.payload.result !== undefined || event.payload.finalOutput === undefined) return event
  return {
    ...event,
    payload: {
      ...event.payload,
      result: event.payload.finalOutput,
    },
  }
}
