import { type Socket, connect } from 'node:net'
import {
  BrokerErrorCode,
  encodeNdjsonFrame,
  isJsonRpcNotification,
} from 'spaces-harness-broker-protocol'
import type { JsonRpcMessage } from 'spaces-harness-broker-protocol'
import { BrokerRpcError, BrokerTransportError } from './errors'
import { type JsonRpcChannelDebugOptions, JsonRpcFramedChannel } from './json-rpc-channel'
import { assertSocketPathWithinBudget } from './socket-path'

export interface UnixSocketTransportConnectOptions {
  socketPath: string
  timeoutMs?: number | undefined
  /** Optional diagnostics hooks for the underlying JSON-RPC channel. */
  debug?: JsonRpcChannelDebugOptions | undefined
}

/** JSON-RPC error code for a superseded ("fenced") controller connection. */
const CONTROLLER_FENCED_CODE = BrokerErrorCode.ControllerFenced

/**
 * JSON-RPC NDJSON transport over a Unix domain socket. The broker is a
 * long-lived server; this transport owns ONLY the client-side socket. Its
 * {@link close} destroys that socket and never terminates the broker process —
 * this is the durability difference versus {@link StdioTransport}, which kills
 * its owned child.
 */
export class UnixSocketTransport extends JsonRpcFramedChannel {
  readonly socket: Socket

  #closePromise: Promise<void>
  #resolveClose!: () => void

  private constructor(socket: Socket, debug?: JsonRpcChannelDebugOptions) {
    super(debug)
    this.socket = socket
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve
    })

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.ingest(chunk)
    })
    socket.once('error', (error) => {
      this.#failClose(new BrokerTransportError('Broker socket error', error))
    })
    socket.once('close', () => {
      const message = this.closed ? 'Broker socket closed' : 'Broker socket closed unexpectedly'
      this.#failClose(new BrokerTransportError(message))
    })
  }

  static async connect(options: UnixSocketTransportConnectOptions): Promise<UnixSocketTransport> {
    assertSocketPathWithinBudget(options.socketPath)

    const socket = connect({ path: options.socketPath })
    await UnixSocketTransport.#awaitConnect(socket, options.socketPath, options.timeoutMs)

    return new UnixSocketTransport(socket, options.debug)
  }

  /**
   * Resolve once the socket connects; reject (and destroy the socket) on a
   * connect error or, when `timeoutMs > 0`, after the deadline. A `settled`
   * latch makes the first outcome win and stops the others from firing.
   */
  static #awaitConnect(
    socket: Socket,
    socketPath: string,
    timeoutMs: number | undefined
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              socket.destroy()
              reject(
                new BrokerTransportError(`Timed out connecting to broker unix socket ${socketPath}`)
              )
            }, timeoutMs)
          : undefined

      socket.once('connect', () => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        if (settled) return
        settled = true
        if (timer !== undefined) clearTimeout(timer)
        reject(new BrokerTransportError('Failed to connect to broker unix socket', error))
      })
    })
  }

  /**
   * Destroy ONLY the client socket. The broker process is a separate,
   * long-lived server and must keep running after the controller disconnects.
   */
  async close(_options: { graceMs?: number | undefined } = {}): Promise<void> {
    if (this.closed) {
      return this.#closePromise
    }

    this.closed = true
    this.rejectPending(new BrokerTransportError('Broker transport closed'))

    if (this.socket.destroyed) {
      this.#resolveClose()
      return this.#closePromise
    }

    this.socket.end()
    this.socket.destroy()

    return this.#closePromise
  }

  protected override handleMessage(message: JsonRpcMessage): void {
    // A `control.fenced` notification means a newer controller attached and
    // this connection has been superseded. Latch the fence as the close cause
    // so a request raced against the close rejects with ControllerFenced rather
    // than a generic transport-closed error.
    if (isJsonRpcNotification(message) && message.method === 'control.fenced') {
      const params = (message.params ?? {}) as { code?: number; message?: string }
      this.#failClose(
        new BrokerRpcError({
          code: params.code ?? CONTROLLER_FENCED_CODE,
          message: params.message ?? 'Controller fenced',
        })
      )
      return
    }

    super.handleMessage(message)
  }

  protected writeFrame(message: JsonRpcMessage): void {
    if (this.failure) {
      throw this.failure
    }
    if (this.socket.destroyed) {
      throw new BrokerTransportError('Broker socket is closed')
    }
    this.socket.write(encodeNdjsonFrame(message))
  }

  /** Latch the close cause and resolve the close promise so {@link close} can settle. */
  #failClose(error: Error): void {
    this.fail(error)
    this.#resolveClose()
  }
}
