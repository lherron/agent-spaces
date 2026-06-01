import type { JsonRpcNotification, JsonRpcRequest } from 'spaces-harness-broker-protocol'
import type { BrokerTransportError } from './errors'

export type NotificationHandler = (notification: JsonRpcNotification) => void
export type RequestHandler = (request: JsonRpcRequest) => Promise<unknown>
export type CloseHandler = (error: BrokerTransportError) => void

/**
 * Transport-agnostic JSON-RPC channel between a {@link BrokerClient} and a
 * broker process. Both {@link StdioTransport} (broker as an owned child) and
 * {@link UnixSocketTransport} (broker as a long-lived server) satisfy this.
 *
 * IMPORTANT: `close()` semantics differ by transport. Stdio owns the broker
 * child and terminates it; the unix socket transport destroys ONLY its own
 * socket and must never terminate the broker process.
 */
export interface BrokerJsonRpcTransport {
  request<T>(method: string, params?: unknown): Promise<T>
  onNotification(handler: NotificationHandler): void
  onRequest(handler: RequestHandler): void
  onClose(handler: CloseHandler): void
  close(options?: { graceMs?: number | undefined }): Promise<void>
}
