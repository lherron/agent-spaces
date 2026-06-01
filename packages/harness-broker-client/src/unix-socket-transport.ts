import { type Socket, connect } from 'node:net'
import {
  NdjsonDecoder,
  createJsonRpcErrorResponse,
  encodeNdjsonFrame,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import type {
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcRequest,
} from 'spaces-harness-broker-protocol'
import { BrokerRpcError, BrokerTransportError } from './errors'
import { assertSocketPathWithinBudget } from './socket-path'
import type {
  BrokerJsonRpcTransport,
  CloseHandler,
  NotificationHandler,
  RequestHandler,
} from './transport'

export interface UnixSocketTransportConnectOptions {
  socketPath: string
  timeoutMs?: number | undefined
}

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * JSON-RPC NDJSON transport over a Unix domain socket. The broker is a
 * long-lived server; this transport owns ONLY the client-side socket. Its
 * {@link close} destroys that socket and never terminates the broker process —
 * this is the durability difference versus {@link StdioTransport}, which kills
 * its owned child.
 */
export class UnixSocketTransport implements BrokerJsonRpcTransport {
  readonly socket: Socket

  #decoder = new NdjsonDecoder()
  #nextId = 1
  #pending = new Map<string, PendingRequest>()
  #notificationHandler: NotificationHandler = () => {}
  #requestHandler: RequestHandler | undefined
  #closeHandler: CloseHandler = () => {}
  #closed = false
  #closeError: BrokerTransportError | undefined
  #closePromise: Promise<void>
  #resolveClose!: () => void

  private constructor(socket: Socket) {
    this.socket = socket
    this.#closePromise = new Promise<void>((resolve) => {
      this.#resolveClose = resolve
    })

    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.#handleData(chunk)
    })
    socket.once('error', (error) => {
      this.#fail(new BrokerTransportError('Broker socket error', error))
    })
    socket.once('close', () => {
      const message = this.#closed
        ? 'Broker socket closed'
        : 'Broker socket closed unexpectedly'
      this.#fail(new BrokerTransportError(message))
    })
  }

  static async connect(
    options: UnixSocketTransportConnectOptions
  ): Promise<UnixSocketTransport> {
    assertSocketPathWithinBudget(options.socketPath)

    const socket = connect({ path: options.socketPath })

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const timeoutMs = options.timeoutMs
      const timer =
        timeoutMs !== undefined && timeoutMs > 0
          ? setTimeout(() => {
              if (settled) return
              settled = true
              socket.destroy()
              reject(
                new BrokerTransportError(
                  `Timed out connecting to broker unix socket ${options.socketPath}`
                )
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

    return new UnixSocketTransport(socket)
  }

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandler = handler
  }

  onRequest(handler: RequestHandler): void {
    this.#requestHandler = handler
  }

  onClose(handler: CloseHandler): void {
    this.#closeHandler = handler
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.#closeError) {
      return Promise.reject(this.#closeError)
    }
    if (this.#closed) {
      return Promise.reject(new BrokerTransportError('Broker transport is closed'))
    }

    const id = `req_${this.#nextId++}`
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
    }
    if (params !== undefined) {
      request.params = params
    }

    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      })
    })
    promise.catch(() => {})

    try {
      this.#write(request)
    } catch (error) {
      this.#pending.delete(id)
      return Promise.reject(error)
    }

    return promise
  }

  /**
   * Destroy ONLY the client socket. The broker process is a separate,
   * long-lived server and must keep running after the controller disconnects.
   */
  async close(_options: { graceMs?: number | undefined } = {}): Promise<void> {
    if (this.#closed) {
      return this.#closePromise
    }

    this.#closed = true
    this.#rejectPending(new BrokerTransportError('Broker transport closed'))

    if (this.socket.destroyed) {
      this.#resolveClose()
      return this.#closePromise
    }

    this.socket.end()
    this.socket.destroy()

    return this.#closePromise
  }

  #handleData(chunk: string): void {
    const frames = this.#decoder.push(chunk)
    for (const frame of frames) {
      if (!frame.ok) {
        this.#fail(new BrokerTransportError('Broker emitted an invalid NDJSON frame', frame.error))
        return
      }
      this.#handleMessage(frame.value)
    }
  }

  #handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const key = this.#idKey(message.id)
      const pending = this.#pending.get(key)
      if (!pending) {
        return
      }
      this.#pending.delete(key)
      if ('error' in message) {
        pending.reject(new BrokerRpcError(message.error))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (isJsonRpcNotification(message)) {
      this.#notificationHandler(message)
      return
    }

    if (isJsonRpcRequest(message)) {
      void this.#handleRequest(message)
    }
  }

  async #handleRequest(request: JsonRpcRequest): Promise<void> {
    if (!this.#requestHandler) {
      this.#write(
        createJsonRpcErrorResponse(request.id, -32601, `Method not found: ${request.method}`)
      )
      return
    }

    try {
      const result = await this.#requestHandler(request)
      this.#write({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      this.#write(
        createJsonRpcErrorResponse(
          request.id,
          -32603,
          error instanceof Error ? error.message : 'Internal client error'
        )
      )
    }
  }

  #write(message: JsonRpcMessage): void {
    if (this.#closeError) {
      throw this.#closeError
    }
    if (this.socket.destroyed) {
      throw new BrokerTransportError('Broker socket is closed')
    }
    this.socket.write(encodeNdjsonFrame(message))
  }

  #fail(error: BrokerTransportError): void {
    if (this.#closeError === undefined) {
      this.#closeError = error
      this.#rejectPending(error)
      this.#closeHandler(error)
    }
    this.#resolveClose()
  }

  #rejectPending(error: BrokerTransportError): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const request of pending) {
      request.reject(error)
    }
  }

  #idKey(id: JsonRpcId): string {
    return String(id)
  }
}
