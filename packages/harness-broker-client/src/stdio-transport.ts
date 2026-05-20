import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
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
  JsonRpcNotification,
  JsonRpcRequest,
} from 'spaces-harness-broker-protocol'
import { BrokerRpcError, BrokerTransportError } from './errors'

export interface StdioTransportStartOptions {
  command: string
  args?: string[] | undefined
  cwd?: string | undefined
  env?: Record<string, string> | undefined
}

export type NotificationHandler = (notification: JsonRpcNotification) => void
export type RequestHandler = (request: JsonRpcRequest) => Promise<unknown>
export type CloseHandler = (error: BrokerTransportError) => void

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

export class StdioTransport {
  readonly child: ChildProcessWithoutNullStreams

  #decoder = new NdjsonDecoder()
  #nextId = 1
  #pending = new Map<string, PendingRequest>()
  #notificationHandler: NotificationHandler = () => {}
  #requestHandler: RequestHandler | undefined
  #closeHandler: CloseHandler = () => {}
  #closed = false
  #exitError: BrokerTransportError | undefined
  #exitPromise: Promise<void>
  #resolveExit!: () => void
  #stderrTail = ''

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve
    })

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.#handleStdout(chunk)
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#appendStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.once('error', (error) => {
      this.#fail(new BrokerTransportError('Broker process error', error))
    })
    child.once('exit', (code, signal) => {
      const detail =
        signal !== null ? `signal ${signal}` : `exit code ${code === null ? 'unknown' : code}`
      const message = this.#closed
        ? `Broker process closed with ${detail}`
        : `Broker process exited with ${detail}`
      this.#fail(new BrokerTransportError(message))
    })
  }

  static async start(options: StdioTransportStartOptions): Promise<StdioTransport> {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    return new StdioTransport(child)
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
    if (this.#exitError) {
      return Promise.reject(this.#exitError)
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

  async close(options: { graceMs?: number | undefined } = {}): Promise<void> {
    if (this.#closed) {
      return this.#exitPromise
    }

    this.#closed = true
    this.#rejectPending(new BrokerTransportError('Broker transport closed'))

    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.#exitPromise
    }

    const graceMs = options.graceMs ?? 500
    this.child.stdin.end()
    this.child.kill('SIGTERM')

    const exited = await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), graceMs)
      }),
    ])

    if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await this.#exitPromise
    }
  }

  #handleStdout(chunk: Buffer | string): void {
    const frames = this.#decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
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
      const pending = this.#pending.get(this.#idKey(message.id))
      if (!pending) {
        return
      }
      this.#pending.delete(this.#idKey(message.id))
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
    if (this.#exitError) {
      throw this.#exitError
    }
    if (this.child.stdin.destroyed) {
      throw new BrokerTransportError('Broker stdin is closed')
    }
    this.child.stdin.write(encodeNdjsonFrame(message))
  }

  #appendStderr(chunk: string): void {
    this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-4096)
  }

  #fail(error: BrokerTransportError): void {
    if (this.#exitError === undefined) {
      this.#exitError =
        this.#stderrTail.trim().length > 0
          ? new BrokerTransportError(`${error.message}\nBroker stderr:\n${this.#stderrTail.trim()}`)
          : error
      this.#rejectPending(this.#exitError)
      this.#closeHandler(this.#exitError)
    }
    this.#resolveExit()
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
