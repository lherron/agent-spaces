import {
  NdjsonDecoder,
  createJsonRpcErrorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
} from 'spaces-harness-broker-protocol'
import type { JsonRpcId, JsonRpcMessage, JsonRpcRequest } from 'spaces-harness-broker-protocol'
import { BrokerRpcError, BrokerTransportError } from './errors'
import type {
  BrokerJsonRpcTransport,
  CloseHandler,
  NotificationHandler,
  RequestHandler,
} from './transport'

/** JSON-RPC error code for an unrecognized method (`-32601`). */
const JSON_RPC_METHOD_NOT_FOUND = -32601
/** JSON-RPC error code for an internal handler failure (`-32603`). */
const JSON_RPC_INTERNAL_ERROR = -32603

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

/**
 * Optional observability sink notified when a JSON-RPC response arrives whose id
 * is not in the pending-request map (a late response after timeout/reject, a
 * duplicate, or a broker echoing a wrong id). The happy path is unaffected; this
 * only surfaces an otherwise-silent drop for diagnostics.
 */
export type UnmatchedResponseSink = (id: JsonRpcId) => void

/** Debug hooks for a {@link JsonRpcFramedChannel} (all optional, off by default). */
export interface JsonRpcChannelDebugOptions {
  onUnmatchedResponse?: UnmatchedResponseSink | undefined
}

/**
 * Shared NDJSON/JSON-RPC framing for the broker transports. Owns the parts that
 * are identical between {@link StdioTransport} and {@link UnixSocketTransport}:
 * NDJSON decode, request-id allocation, the pending-request map, and
 * request/response/notification routing.
 *
 * Each concrete transport supplies only the channel-specific behavior:
 *   - {@link writeFrame} — the wire sink (child stdin vs. socket).
 *   - {@link close} — the teardown strategy (kill owned child vs. destroy socket).
 *   - the failure latch — by calling {@link fail} from its own error/close events.
 *
 * Subclasses may override {@link handleMessage} to add channel-specific
 * notifications (e.g. the unix `control.fenced` fence) before delegating to
 * `super.handleMessage`.
 */
export abstract class JsonRpcFramedChannel implements BrokerJsonRpcTransport {
  protected readonly decoder = new NdjsonDecoder()

  #nextId = 1
  #pending = new Map<string, PendingRequest>()
  #notificationHandler: NotificationHandler = () => {}
  #requestHandler: RequestHandler | undefined
  #closeHandler: CloseHandler = () => {}
  #onUnmatchedResponse: UnmatchedResponseSink | undefined
  #unmatchedResponseCount = 0

  protected constructor(debug: JsonRpcChannelDebugOptions = {}) {
    this.#onUnmatchedResponse = debug.onUnmatchedResponse
  }

  /**
   * Count of inbound responses dropped because their id was not pending. Stays
   * at `0` on a healthy channel; a nonzero value flags late/duplicate/wrong-id
   * responses (see {@link UnmatchedResponseSink}).
   */
  get unmatchedResponseCount(): number {
    return this.#unmatchedResponseCount
  }

  /** Latched once the channel has been torn down or failed. */
  protected closed = false
  /** Latched failure cause; once set, all requests/writes reject with it. */
  protected failure: Error | undefined

  onNotification(handler: NotificationHandler): void {
    this.#notificationHandler = handler
  }

  onRequest(handler: RequestHandler): void {
    this.#requestHandler = handler
  }

  onClose(handler: CloseHandler): void {
    this.#closeHandler = handler
  }

  abstract close(options?: { graceMs?: number | undefined }): Promise<void>

  request<T>(method: string, params?: unknown): Promise<T> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    if (this.closed) {
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
    // Avoid unhandled-rejection warnings while the caller has not yet attached
    // its own handler; the real settlement is returned below.
    promise.catch(() => {})

    try {
      this.writeFrame(request)
    } catch (error) {
      this.#pending.delete(id)
      return Promise.reject(error)
    }

    return promise
  }

  /** Decode an inbound chunk and route every complete frame. */
  protected ingest(chunk: string): void {
    const frames = this.decoder.push(chunk)
    for (const frame of frames) {
      if (!frame.ok) {
        this.fail(new BrokerTransportError('Broker emitted an invalid NDJSON frame', frame.error))
        return
      }
      this.handleMessage(frame.value)
    }
  }

  /**
   * Route a single JSON-RPC message. Subclasses may override to intercept
   * channel-specific notifications, then delegate to `super.handleMessage`.
   */
  protected handleMessage(message: JsonRpcMessage): void {
    if (isJsonRpcResponse(message)) {
      const key = this.#idKey(message.id)
      const pending = this.#pending.get(key)
      if (!pending) {
        // Late, duplicate, or wrong-id response: drop it from the happy path but
        // record it so the silent loss is observable for diagnostics.
        this.#unmatchedResponseCount += 1
        this.#onUnmatchedResponse?.(message.id)
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
      this.writeFrame(
        createJsonRpcErrorResponse(
          request.id,
          JSON_RPC_METHOD_NOT_FOUND,
          `Method not found: ${request.method}`
        )
      )
      return
    }

    try {
      const result = await this.#requestHandler(request)
      this.writeFrame({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      this.writeFrame(
        createJsonRpcErrorResponse(
          request.id,
          JSON_RPC_INTERNAL_ERROR,
          error instanceof Error ? error.message : 'Internal client error'
        )
      )
    }
  }

  /**
   * Latch a terminal failure: reject all pending requests and notify the close
   * handler exactly once. Idempotent.
   */
  protected fail(error: Error): void {
    if (this.failure === undefined) {
      this.failure = error
      this.rejectPending(error)
      this.#closeHandler(error)
    }
  }

  /** Reject and clear every in-flight request with the given cause. */
  protected rejectPending(error: Error): void {
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const request of pending) {
      request.reject(error)
    }
  }

  #idKey(id: JsonRpcId): string {
    return String(id)
  }

  /** Throw the latched failure cause if the channel has already failed. */
  protected assertWritable(): void {
    if (this.failure) {
      throw this.failure
    }
  }

  /** Write a single frame to the underlying channel (child stdin / socket). */
  protected abstract writeFrame(message: JsonRpcMessage): void
}
