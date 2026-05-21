import type { Readable, Writable } from 'node:stream'
import {
  NdjsonDecoder,
  createJsonRpcErrorResponse,
  encodeNdjsonFrame,
  isJsonRpcRequest,
} from 'spaces-harness-broker-protocol'
import type { JsonRpcId, JsonRpcMessage, JsonRpcNotification } from 'spaces-harness-broker-protocol'
import { toJsonRpcError } from './errors'

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

export interface ProtocolServer {
  register(method: string, handler: RequestHandler): void
  start(): Promise<void>
  notify(notification: JsonRpcNotification): void
  close(): Promise<void>
}

export function createProtocolServer(options: ProtocolServerOptions): ProtocolServer {
  const { stdin, stdout } = options
  const handlers = new Map<string, RequestHandler>()
  const decoder = new NdjsonDecoder()
  let closed = false

  function writeFrame(message: JsonRpcMessage): void {
    if (closed) return
    stdout.write(encodeNdjsonFrame(message))
  }

  function handleLine(frame: JsonRpcMessage): void {
    if (!isJsonRpcRequest(frame)) {
      // Ignore non-request frames (responses, notifications from client side)
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
        handleLine(result.value)
      } else {
        // Malformed frame: respond with parse error (id = null per JSON-RPC)
        writeFrame(createJsonRpcErrorResponse(null, -32700, 'Parse error'))
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

    async close(): Promise<void> {
      closed = true
      stdin.removeListener('data', onData)
    },
  }
}
