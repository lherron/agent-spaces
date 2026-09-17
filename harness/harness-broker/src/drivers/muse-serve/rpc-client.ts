/**
 * Muse serve stdio JSON-RPC peer (T-08589, campaign P-00522).
 *
 * Newline-delimited JSON-RPC 2.0 over the owned `muse serve` child's stdio
 * (spike 2, probed live against muse 1.3.0). Mirrors the CodexRpcClient stdio
 * shape — pending-map requests with verbatim-frame observation, server
 * notifications, and server-initiated requests (approval/request,
 * userInput/request) — without the websocket variant serve does not speak.
 */
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { JsonRpcId } from 'spaces-harness-broker-protocol'

export interface MuseJsonRpcRequest {
  jsonrpc: '2.0'
  id: JsonRpcId
  method: string
  params?: unknown
}

export interface MuseJsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface MuseJsonRpcResponse {
  jsonrpc: '2.0'
  id: JsonRpcId
  result?: unknown
  error?: {
    code: number
    message: string
    data?: unknown
  }
}

export type MuseJsonRpcMessage = MuseJsonRpcRequest | MuseJsonRpcNotification | MuseJsonRpcResponse

export class MuseRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'MuseRpcError'
    this.code = code
    this.data = data
  }
}

export interface MuseRpcHandlers {
  /**
   * `rawFrame` is the VERBATIM line the provider wrote, before any re-encoding
   * (capture-gate §7.1: raw provider bytes remain verbatim).
   */
  onNotification?: ((message: MuseJsonRpcNotification, rawFrame: string) => void) | undefined
  /** Server-initiated request (approval/request, userInput/request). */
  onRequest?: ((message: MuseJsonRpcRequest, rawFrame?: string) => Promise<unknown>) | undefined
  onMessage?: ((message: MuseJsonRpcMessage) => void) | undefined
  onError?: ((error: Error) => void) | undefined
}

export interface MuseRpcPeer {
  sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T>
  sendNotification(method: string, params?: unknown): Promise<void>
  close(error?: Error): void
}

function isResponse(message: MuseJsonRpcMessage): message is MuseJsonRpcResponse {
  return (message as MuseJsonRpcResponse).id !== undefined
}

function isServerRequest(message: MuseJsonRpcMessage): message is MuseJsonRpcRequest {
  const candidate = message as Partial<MuseJsonRpcRequest>
  return candidate.id !== undefined && typeof candidate.method === 'string'
}

export class MuseRpcClient implements MuseRpcPeer {
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
  private readonly handlers: MuseRpcHandlers

  constructor(
    private readonly proc: ChildProcessWithoutNullStreams,
    handlers: MuseRpcHandlers = {}
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
      this.handleError(new Error(`muse serve exited with ${reason}`))
    })
  }

  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    observeResult?: ((value: T, rawFrame: string) => void) | undefined
  ): Promise<T> {
    const id = this.nextId++
    const request: MuseJsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    }
    const response = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        observeResult: observeResult as ((value: unknown, rawFrame: string) => void) | undefined,
      })
    })
    if (this.closed) {
      this.pending.delete(id)
      throw new MuseRpcError(-32000, `muse serve connection closed before ${method}`)
    }
    await this.writeMessage(request)
    return response
  }

  async sendNotification(method: string, params?: unknown): Promise<void> {
    if (this.closed) return
    const notification: MuseJsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      ...(params !== undefined ? { params } : {}),
    }
    this.proc.stdin.write(`${JSON.stringify(notification)}\n`)
  }

  close(error?: Error): void {
    if (this.closed) return
    this.closed = true
    const failure = error ?? new Error('muse serve connection closed')
    for (const waiter of this.pending.values()) {
      waiter.reject(failure)
    }
    this.pending.clear()
    this.proc.stdin.end()
  }

  private writeMessage(message: MuseJsonRpcRequest | MuseJsonRpcNotification): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim()
    if (!trimmed) return
    let message: MuseJsonRpcMessage
    try {
      message = JSON.parse(trimmed) as MuseJsonRpcMessage
    } catch {
      this.handlers.onError?.(new Error(`muse serve wrote non-JSON line: ${trimmed.slice(0, 200)}`))
      return
    }
    this.handlers.onMessage?.(message)
    if (isServerRequest(message)) {
      const request = message
      try {
        const result = await this.handlers.onRequest?.(request, trimmed)
        if (!this.closed) {
          this.proc.stdin.write(
            `${JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result ?? null })}\n`
          )
        }
      } catch (error) {
        if (!this.closed) {
          this.proc.stdin.write(
            `${JSON.stringify({
              jsonrpc: '2.0',
              id: request.id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            })}\n`
          )
        }
      }
      return
    }
    if (isResponse(message)) {
      const waiter = this.pending.get(message.id)
      if (!waiter) return
      this.pending.delete(message.id)
      if (message.error !== undefined) {
        waiter.reject(
          new MuseRpcError(message.error.code, message.error.message, message.error.data)
        )
        return
      }
      try {
        waiter.observeResult?.(message.result, trimmed)
      } catch (error) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)))
        return
      }
      waiter.resolve(message.result)
      return
    }
    if ((message as MuseJsonRpcNotification).method !== undefined) {
      this.handlers.onNotification?.(message as MuseJsonRpcNotification, trimmed)
      return
    }
    this.handlers.onError?.(
      new Error(`muse serve wrote an id-less error frame: ${trimmed.slice(0, 200)}`)
    )
  }

  private handleError(error: Error): void {
    this.handlers.onError?.(error)
    this.close(error)
  }
}
