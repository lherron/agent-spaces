import type { Server, Socket } from 'node:net'
import type {
  AgentHarnessControlAck,
  AgentHarnessControlFrame,
  AgentHarnessControlRequest,
} from 'spaces-harness-broker-protocol'
import {
  AgentHarnessControlDecoder,
  encodeAgentHarnessControlFrame,
  isAgentHarnessControlAckLine,
  validateAgentHarnessControlAck,
} from 'spaces-harness-broker-protocol'

export interface AgentHarnessControlListenerContext {
  invocationId: string
  runtimeId?: string | undefined
}

export type AgentHarnessControlFrameHandler = (frame: AgentHarnessControlFrame) => Promise<void>

export interface AgentHarnessControlListenerHandle {
  socketPath: string
  /** Send an ack-bearing frame and resolve when the TUI acknowledges it. */
  request(frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck>
  close(): Promise<void>
}

export interface AgentHarnessControlListener {
  listen(
    handler: AgentHarnessControlFrameHandler,
    context: AgentHarnessControlListenerContext
  ): Promise<AgentHarnessControlListenerHandle>
}

interface PendingRequest {
  requestId: string
  resolve: (ack: AgentHarnessControlAck) => void
  reject: (error: Error) => void
}

/**
 * Bind the driver-owned `agent-harness-control/v1` socket. The driver is the
 * SERVER: it creates the socket, hands the path to the TUI as
 * `--broker-control-socket`, and the TUI connects as the single client.
 *
 * Ack lines are NOT control frames (the verb set is closed to the five wire
 * verbs), so they are correlated before frame validation: by `requestId` when
 * the child echoes it, otherwise in FIFO issue order. Both polarities correlate
 * identically — a negative ack is an ANSWER to the request, so it settles the
 * pending promise with `{ack:false}` rather than rejecting it. Only a
 * MALFORMED ack (unknown code, missing message) rejects, because that is the
 * one shape the driver cannot act on.
 */
export async function listenForAgentHarnessControl(
  socketPath: string,
  handler: AgentHarnessControlFrameHandler
): Promise<AgentHarnessControlListenerHandle> {
  const { createServer } = await import('node:net')
  const { mkdir, rm } = await import('node:fs/promises')
  const { dirname } = await import('node:path')

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined)
  await rm(socketPath, { force: true }).catch(() => undefined)

  const connections = new Set<Socket>()
  const pending: PendingRequest[] = []
  let active: Socket | undefined
  let drain: Promise<void> = Promise.resolve()

  const settle = (line: Record<string, unknown>): void => {
    const requestId = typeof line['requestId'] === 'string' ? line['requestId'] : undefined
    const index =
      requestId === undefined ? 0 : pending.findIndex((entry) => entry.requestId === requestId)
    if (index < 0) return
    const [entry] = pending.splice(index, 1)
    if (entry === undefined) return
    try {
      entry.resolve(validateAgentHarnessControlAck(line))
    } catch (error) {
      entry.reject(
        error instanceof Error
          ? error
          : new Error('agent-harness control acknowledgement is malformed')
      )
    }
  }

  const failPending = (reason: string): void => {
    for (const entry of pending.splice(0)) {
      entry.reject(new Error(reason))
    }
  }

  const server: Server = createServer({ allowHalfOpen: false }, (conn) => {
    connections.add(conn)
    active = conn
    conn.setEncoding('utf8')
    const decoder = new AgentHarnessControlDecoder()
    conn.on('data', (chunk: string) => {
      // Ack lines never reach the frame decoder: they are not control frames.
      const frames: string[] = []
      for (const rawLine of chunk.split('\n')) {
        const line = rawLine.trim()
        if (line.length === 0) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          frames.push(`${line}\n`)
          continue
        }
        if (isAgentHarnessControlAckLine(parsed)) {
          settle(parsed as Record<string, unknown>)
          continue
        }
        frames.push(`${line}\n`)
      }
      for (const encoded of frames) {
        for (const result of decoder.push(encoded)) {
          if (!result.ok) {
            drain = drain.then(() => Promise.reject(result.error)).catch(() => undefined)
            continue
          }
          const frame = result.value
          drain = drain.then(
            () => handler(frame),
            () => handler(frame)
          )
          void drain.catch(() => undefined)
        }
      }
    })
    conn.once('close', () => {
      connections.delete(conn)
      if (active === conn) active = undefined
      failPending('agent-harness control connection closed before acknowledgement')
    })
    conn.on('error', () => undefined)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  let closePromise: Promise<void> | undefined
  return {
    socketPath,
    request(frame: AgentHarnessControlRequest): Promise<AgentHarnessControlAck> {
      const socket = active
      if (socket === undefined) {
        return Promise.reject(new Error('agent-harness control channel has no connected TUI'))
      }
      const encoded = encodeAgentHarnessControlFrame(frame)
      return new Promise<AgentHarnessControlAck>((resolve, reject) => {
        pending.push({ requestId: frame.requestId, resolve, reject })
        socket.write(encoded, (error) => {
          if (error === undefined || error === null) return
          const index = pending.findIndex((entry) => entry.requestId === frame.requestId)
          if (index >= 0) pending.splice(index, 1)
          reject(error)
        })
      })
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        failPending('agent-harness control channel closed')
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          for (const connection of connections) connection.destroy()
        })
        await rm(socketPath, { force: true }).catch(() => undefined)
      })()
      return closePromise
    },
  }
}
