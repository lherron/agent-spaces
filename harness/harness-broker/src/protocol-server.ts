import type { Readable, Writable } from 'node:stream'
import {
  NdjsonDecoder,
  createJsonRpcErrorResponse,
  encodeNdjsonFrame,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import type {
  JsonRpcError,
  JsonRpcId,
  JsonRpcMessage,
  JsonRpcNotification,
} from 'spaces-harness-broker-protocol'
import { fromJsonRpcError, shutdownError, timeoutError, toJsonRpcError } from './errors'

export type RequestHandler = (request: {
  id: JsonRpcId
  method: string
  params: unknown
  /** The request envelope's `client` (`<name>/<version>`), or `unknown`. */
  client?: string | undefined
}) => Promise<unknown>

export interface ProtocolServerOptions {
  stdin: Readable
  stdout: Writable
  stderr: Writable
  /** Opt-in framing policy for public services; private broker defaults stay unchanged. */
  maxFrameBytes?: number | undefined
  rejectEmptyFrames?: boolean | undefined
  /** Add service-specific guidance once, for every transport error. */
  decorateError?: ((error: JsonRpcError, method: string) => JsonRpcError) | undefined
  /** Optional observation only; response framing and dispatch remain unchanged. */
  onRequestComplete?: ((completion: ProtocolRequestCompletion) => void) | undefined
}

export interface ProtocolRequestCompletion {
  method: string
  client: string
  durationMs: number
  result?: unknown
  error?: { code: number; message: string } | undefined
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
  const frameParts: Buffer[] = []
  let frameBytes = 0
  let discardingFrame = false
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

  function complete(completion: ProtocolRequestCompletion): void {
    try {
      options.onRequestComplete?.(completion)
    } catch (error) {
      options.stderr.write(`RPC request observation failed: ${String(error)}\n`)
    }
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

    const started = performance.now()
    const rawClient = (frame as unknown as Record<string, unknown>)['client']
    const client = typeof rawClient === 'string' && rawClient.length > 0 ? rawClient : 'unknown'
    const answered = (fields: Pick<ProtocolRequestCompletion, 'result' | 'error'>): void =>
      complete({ method: frame.method, client, durationMs: performance.now() - started, ...fields })

    const handler = handlers.get(frame.method)
    if (!handler) {
      const response = createJsonRpcErrorResponse(
        frame.id,
        -32601,
        `Method not found: ${frame.method}`
      )
      response.error = options.decorateError?.(response.error, frame.method) ?? response.error
      writeFrame(response)
      answered({ error: response.error })
      return
    }

    // Fire-and-forget (async handler)
    void handler({ id: frame.id, method: frame.method, params: frame.params, client }).then(
      (result) => {
        writeFrame({
          jsonrpc: '2.0',
          id: frame.id,
          result,
        })
        answered({ result })
      },
      (err: unknown) => {
        const original = toJsonRpcError(err)
        const rpcError = options.decorateError?.(original, frame.method) ?? original
        writeFrame({
          jsonrpc: '2.0',
          id: frame.id,
          error: rpcError,
        })
        answered({ error: rpcError })
      }
    )
  }

  function refuseFrame(reason: 'parse_error' | 'empty_frame' | 'frame_too_large'): void {
    consecutiveParseErrors += 1
    const message =
      reason === 'empty_frame'
        ? 'Empty NDJSON frame'
        : reason === 'frame_too_large'
          ? `NDJSON frame exceeds ${options.maxFrameBytes} bytes`
          : 'Parse error'
    const response = createJsonRpcErrorResponse(null, -32700, message)
    // Only opted-in public services receive the additive reason/guidance.
    if (options.decorateError) {
      response.error = options.decorateError({ ...response.error, data: { reason } }, 'unmatched')
    }
    if (
      options.maxFrameBytes !== undefined ||
      consecutiveParseErrors <= MAX_CONSECUTIVE_PARSE_ERRORS
    ) {
      writeFrame(response)
    }
    complete({ method: 'unmatched', client: 'unknown', durationMs: 0, error: response.error })
  }

  function decode(chunk: Buffer | string): void {
    for (const result of decoder.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))) {
      if (result.ok) {
        consecutiveParseErrors = 0
        handleLine(result.value)
      } else {
        refuseFrame('parse_error')
      }
    }
  }

  function onData(chunk: Buffer | string): void {
    if (options.maxFrameBytes === undefined) {
      decode(chunk)
      return
    }
    // Scan bytes before concatenation/JSON parsing. Refuse once at the bound,
    // discard until the delimiter, then resume on this same connection. Retained
    // memory never grows with an unterminated oversized request.
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    let offset = 0
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset)
      const end = newline === -1 ? bytes.length : newline
      const part = bytes.subarray(offset, end)
      if (!discardingFrame) {
        frameBytes += part.length
        if (frameBytes > options.maxFrameBytes) {
          frameParts.length = 0
          discardingFrame = true
          refuseFrame('frame_too_large')
        } else if (part.length > 0) {
          frameParts.push(part)
        }
      }
      if (newline !== -1) {
        if (!discardingFrame) {
          const frame = Buffer.concat(frameParts, frameBytes)
          if (
            options.rejectEmptyFrames &&
            (frame.length === 0 || (frame.length === 1 && frame[0] === 13))
          ) {
            refuseFrame('empty_frame')
          } else {
            decode(Buffer.concat([frame, Buffer.from('\n')]))
          }
        }
        frameParts.length = 0
        frameBytes = 0
        discardingFrame = false
      }
      offset = newline === -1 ? bytes.length : newline + 1
    }
  }

  return {
    register(method: string, handler: RequestHandler): void {
      handlers.set(method, handler)
    },

    async start(): Promise<void> {
      stdin.on('data', onData)
      stdin.on('end', () => {
        // Keep the existing EOF semantics for a bounded trailing partial frame.
        if (!discardingFrame && frameBytes > 0) decode(Buffer.concat(frameParts, frameBytes))
        frameParts.length = 0
        frameBytes = 0
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
