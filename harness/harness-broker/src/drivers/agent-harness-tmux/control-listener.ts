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
  /**
   * Called once when the connected TUI goes away for a reason the driver did not
   * ask for — `/quit`, a crash, a killed pane. The TUI's own goodbye (a
   * `continuation.cleared` event frame) is what distinguishes a clean exit from
   * a crash; this fires either way and is what makes the child's death OBSERVABLE
   * at all, so a runtime whose TUI is gone cannot sit `ready` forever.
   *
   * It rides the context rather than the returned handle so there is no window
   * between `listen` resolving and the driver wiring itself up in which a
   * disconnect could be missed.
   */
  onDisconnect?: (() => void) | undefined
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
 * Ack lines are NOT control frames (the verb set is closed to the six wire
 * verbs), so they are correlated before frame validation: by `requestId` when
 * the child echoes it, otherwise in FIFO issue order. Both polarities correlate
 * identically — a negative ack is an ANSWER to the request, so it settles the
 * pending promise with `{ack:false}` rather than rejecting it. Only a
 * MALFORMED ack (unknown code, missing message) rejects, because that is the
 * one shape the driver cannot act on.
 */
export async function listenForAgentHarnessControl(
  socketPath: string,
  handler: AgentHarnessControlFrameHandler,
  onDisconnect?: (() => void) | undefined
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
  // Set the instant the DRIVER tears the channel down, so its own `close()`
  // (dispose/stop) destroying the connection is never mistaken for the child
  // dying underneath us.
  let closing = false

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
    // Reassembly buffer for THIS connection. A socket read boundary falls
    // wherever the kernel put it, so a frame arrives split across `data` events
    // whenever it exceeds one read (8KB here) or the writer outruns the reader.
    // Splitting a raw chunk into lines and re-terminating each piece would turn
    // one straddling frame into two malformed "complete" lines and drop it
    // silently — which cost every turn whose final assistant message exceeded a
    // single read its `turn.completed`, wedging the seat (T-07866). Only
    // COMPLETE lines are classified.
    let buffer = ''
    conn.on('data', (chunk: string) => {
      buffer += chunk
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const rawLine = buffer.slice(0, newlineIndex)
        buffer = buffer.slice(newlineIndex + 1)
        newlineIndex = buffer.indexOf('\n')
        const line = rawLine.trim()
        if (line.length === 0) continue
        // Ack lines never reach the frame decoder: they are not control frames.
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch {
          // Not JSON at all. Hand it to the decoder so a malformed frame is
          // reported through the one path that reports them.
          dispatch(line)
          continue
        }
        if (isAgentHarnessControlAckLine(parsed)) {
          settle(parsed as Record<string, unknown>)
          continue
        }
        dispatch(line)
      }
    })

    /** Decode one COMPLETE line and sequence its handler call behind the drain. */
    function dispatch(line: string): void {
      for (const result of decoder.push(`${line}\n`)) {
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
    conn.once('close', () => {
      connections.delete(conn)
      const wasActive = active === conn
      if (wasActive) active = undefined
      failPending('agent-harness control connection closed before acknowledgement')
      if (!wasActive || closing || onDisconnect === undefined) return
      // Sequence the disconnect BEHIND every frame this connection already
      // delivered. 'close' can fire while the last frames are still draining,
      // and a teardown that overtook the `/quit` continuation clear would make
      // a clean exit indistinguishable from a crash — the exact bug this
      // callback exists to close.
      drain = drain.then(
        () => onDisconnect(),
        () => onDisconnect()
      )
      void drain.catch(() => undefined)
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
      closing = true
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
