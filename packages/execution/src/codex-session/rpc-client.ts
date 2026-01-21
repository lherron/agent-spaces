import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'

export type JsonRpcId = number | string

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

interface RpcHandlers {
  onNotification?: (message: JsonRpcNotification) => void
  onRequest?: (message: JsonRpcRequest) => Promise<unknown>
  onMessage?: (message: JsonRpcMessage) => void
  onError?: (error: Error) => void
}

export class CodexRpcClient {
  private nextId = 1
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
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

  async sendRequest<T = unknown>(method: string, params?: unknown): Promise<T> {
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

  close(): void {
    this.closed = true
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
      this.handleResponse(message)
      return
    }

    if (this.isRequest(message)) {
      await this.handleRequest(message)
      return
    }

    if (this.isNotification(message)) {
      this.handlers.onNotification?.(message)
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

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id)
    if (!pending) {
      this.handleError(new Error(`Unexpected JSON-RPC response id: ${message.id}`))
      return
    }
    this.pending.delete(message.id)

    if (message.error) {
      pending.reject(
        new Error(
          `JSON-RPC error ${message.error.code}: ${message.error.message}${
            message.error.data ? ` (${JSON.stringify(message.error.data)})` : ''
          }`
        )
      )
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
