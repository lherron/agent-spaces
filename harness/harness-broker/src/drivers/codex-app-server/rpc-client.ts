import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import type { JsonRpcId } from 'spaces-harness-broker-protocol'

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

export class CodexRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'CodexRpcError'
    this.code = code
    this.data = data
  }
}

interface RpcHandlers {
  /**
   * `rawFrame` is the VERBATIM line the provider wrote, before any re-encoding.
   * The capture gate commits those bytes (§7.1: raw provider bytes remain
   * verbatim) and the normalizer reads them back, so the parsed `message` here
   * is a convenience for the transport's own routing — never the copy a
   * committed record is derived from.
   */
  onNotification?: ((message: JsonRpcNotification, rawFrame: string) => void) | undefined
  onRequest?: ((message: JsonRpcRequest) => Promise<unknown>) | undefined
  onMessage?: ((message: JsonRpcMessage) => void) | undefined
  onError?: ((error: Error) => void) | undefined
}

export class CodexRpcClient {
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      observeResult?: ((value: unknown, rawFrame: string) => void) | undefined
    }
  >()
  private closed = false
  private readonly handlers: RpcHandlers

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    handlers: RpcHandlers = {}
  ) {
    this.handlers = handlers
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      void this.handleLine(line)
    })

    proc.on('error', (error) => {
      this.handleError(error instanceof Error ? error : new Error(String(error)))
    })

    proc.on('exit', (code, signal) => {
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? 'unknown'}`
      this.handleError(new Error(`Codex app-server exited with ${reason}`))
    })
  }

  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T> {
    const id = this.nextId++
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(observeResult !== undefined
          ? { observeResult: observeResult as (value: unknown, rawFrame: string) => void }
          : {}),
      })
    })
    await this.writeMessage(request)
    return response
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    await this.writeMessage(notification)
  }

  close(error: Error = new Error('JSON-RPC client is closed')): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.proc.stdin.end()
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return

    let message: JsonRpcMessage
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage
    } catch (error) {
      this.handleError(
        new Error(
          `Failed to parse JSON-RPC message: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
      )
      return
    }

    this.handlers.onMessage?.(message)

    if (this.isResponse(message)) {
      this.handleResponse(message, trimmed)
      return
    }

    if (this.isRequest(message)) {
      await this.handleRequest(message)
      return
    }

    if (this.isNotification(message)) {
      this.handlers.onNotification?.(message, trimmed)
    }
  }

  private isResponse(message: JsonRpcMessage): message is JsonRpcResponse {
    return 'id' in message && !('method' in message)
  }

  private isRequest(message: JsonRpcMessage): message is JsonRpcRequest {
    return 'method' in message && 'id' in message
  }

  private isNotification(message: JsonRpcMessage): message is JsonRpcNotification {
    return 'method' in message && !('id' in message)
  }

  private handleResponse(message: JsonRpcResponse, rawFrame: string): void {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.handleError(new Error(`Unexpected JSON-RPC response id: ${message.id}`))
      return
    }
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(
        new CodexRpcError(message.error.code, message.error.message, message.error.data)
      )
      return
    }

    try {
      pending.observeResult?.(message.result, rawFrame)
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)))
      return
    }

    pending.resolve(message.result)
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    if (!this.handlers.onRequest) {
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: `Unhandled request: ${message.method}` },
      } satisfies JsonRpcResponse)
      return
    }

    try {
      const result = await this.handlers.onRequest(message)
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        result,
      } satisfies JsonRpcResponse)
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      await this.writeMessage({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: messageText },
      } satisfies JsonRpcResponse)
      this.handleError(error instanceof Error ? error : new Error(messageText))
    }
  }

  private async writeMessage(message: JsonRpcMessage): Promise<void> {
    if (this.closed) {
      throw new Error('JSON-RPC client is closed')
    }

    const payload = `${JSON.stringify(message)}\n`
    const wrote = this.proc.stdin.write(payload)
    if (!wrote) {
      await once(this.proc.stdin, 'drain')
    }
  }

  private handleError(error: Error): void {
    if (this.closed) return
    this.closed = true
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
    this.handlers.onError?.(error)
  }
}
