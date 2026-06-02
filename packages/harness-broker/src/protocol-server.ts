import type { Readable, Writable } from 'node:stream'
import {
  NdjsonDecoder,
  createJsonRpcErrorResponse,
  encodeNdjsonFrame,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import type { JsonRpcId, JsonRpcMessage, JsonRpcNotification } from 'spaces-harness-broker-protocol'
import { fromJsonRpcError, shutdownError, timeoutError, toJsonRpcError } from './errors'

export type RequestHandler = (request: {
  id: JsonRpcId
  method: string
  params: unknown
}) => Promise<unknown>

export interface ProtocolServerOptions {
  stdin: Readable
  stdout: Writable
  stderr: Writable
}

export interface ProtocolServerRequestOptions {
  timeoutMs?: number | undefined
}

export interface ProtocolServer {
  register(method: string, handler: RequestHandler): void
  start(): Promise<void>
  request<T>(method: string, params: unknown, options?: ProtocolServerRequestOptions): Promise<T>
  notify(notification: JsonRpcNotification): void
  close(): Promise<void>
}

interface PendingRequest {
  timer?: ReturnType<typeof setTimeout> | undefined
  resolve(value: unknown): void
  reject(reason: unknown): void
}

export function createProtocolServer(options: ProtocolServerOptions): ProtocolServer {
  const { stdin, stdout } = options
  const handlers = new Map<string, RequestHandler>()
  const pendingRequests = new Map<JsonRpcId, PendingRequest>()
  const decoder = new NdjsonDecoder()
  let closed = false
  let nextRequestId = 1
  // Robustness bound (refactor A9): a peer streaming non-NDJSON bytes would
  // otherwise produce one parse-error frame per malformed line with no cap,
  // amplifying a single bad chunk into unbounded writes. We stop emitting
  // parse-error frames once this many parse errors arrive without any
  // intervening well-formed frame; any successfully decoded frame resets the
  // run. Well-formed traffic is unaffected.
  const MAX_CONSECUTIVE_PARSE_ERRORS = 64
  let consecutiveParseErrors = 0

  function writeFrame(message: JsonRpcMessage): void {
    if (closed) return
    stdout.write(encodeNdjsonFrame(message))
  }

  function settlePending(id: JsonRpcId, settle: (pending: PendingRequest) => void): void {
    const pending = pendingRequests.get(id)
    if (!pending) return

    pendingRequests.delete(id)
    if (pending.timer !== undefined) {
      clearTimeout(pending.timer)
    }
    settle(pending)
  }

  function rejectAllPending(reason: unknown): void {
    for (const id of pendingRequests.keys()) {
      settlePending(id, (pending) => pending.reject(reason))
    }
  }

  function handleLine(frame: JsonRpcMessage): void {
    if (isJsonRpcResponse(frame)) {
      settlePending(frame.id, (pending) => {
        if ('error' in frame) {
          pending.reject(fromJsonRpcError(frame.error))
        } else {
          pending.resolve(frame.result)
        }
      })
      return
    }

    if (!isJsonRpcRequest(frame)) {
      // Client-side notifications have no response path in the broker protocol.
      return
    }

    const handler = handlers.get(frame.method)
    if (!handler) {
      writeFrame(createJsonRpcErrorResponse(frame.id, -32601, `Method not found: ${frame.method}`))
      return
    }

    // Fire-and-forget (async handler)
    void handler({ id: frame.id, method: frame.method, params: frame.params }).then(
      (result) => {
        writeFrame({
          jsonrpc: '2.0',
          id: frame.id,
          result,
        })
      },
      (err: unknown) => {
        const rpcError = toJsonRpcError(err)
        writeFrame({
          jsonrpc: '2.0',
          id: frame.id,
          error: rpcError,
        })
      }
    )
  }

  function onData(chunk: Buffer | string): void {
    const results = decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    for (const result of results) {
      if (result.ok) {
        // A well-formed frame ends any run of parse errors.
        consecutiveParseErrors = 0
        handleLine(result.value)
      } else {
        // Malformed frame: respond with parse error (id = null per JSON-RPC),
        // but cap the reply rate so a stream of garbage can't amplify into
        // unbounded writes (refactor A9). Once the cap is reached we silently
        // drop further parse-error frames until a valid frame resets the run.
        consecutiveParseErrors += 1
        if (consecutiveParseErrors <= MAX_CONSECUTIVE_PARSE_ERRORS) {
          writeFrame(createJsonRpcErrorResponse(null, -32700, 'Parse error'))
        }
      }
    }
  }

  return {
    register(method: string, handler: RequestHandler): void {
      handlers.set(method, handler)
    },

    async start(): Promise<void> {
      stdin.on('data', onData)
      stdin.on('end', () => {
        // Flush remaining buffer
        const remaining = decoder.flush()
        for (const result of remaining) {
          if (result.ok) {
            handleLine(result.value)
          }
        }
      })
    },

    notify(notification: JsonRpcNotification): void {
      writeFrame(notification)
    },

    request<T>(
      method: string,
      params: unknown,
      options: ProtocolServerRequestOptions = {}
    ): Promise<T> {
      if (closed) {
        return Promise.reject(shutdownError('Protocol server is closed'))
      }

      const id = `broker_req_${nextRequestId++}`
      return new Promise<T>((resolve, reject) => {
        const pending: PendingRequest = {
          resolve: (value) => resolve(value as T),
          reject,
        }

        if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
          pending.timer = setTimeout(() => {
            settlePending(id, (timedOut) => {
              timedOut.reject(timeoutError(`Request timed out: ${method}`))
            })
          }, options.timeoutMs)
        }

        pendingRequests.set(id, pending)
        writeFrame({
          jsonrpc: '2.0',
          id,
          method,
          params,
        })
      })
    },

    async close(): Promise<void> {
      closed = true
      stdin.removeListener('data', onData)
      rejectAllPending(shutdownError('Protocol server is closed'))
    },
  }
}
