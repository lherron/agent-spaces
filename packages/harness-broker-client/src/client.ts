import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  HarnessInvocationSpec,
  InvocationAckEventsRequest,
  InvocationAckEventsResponse,
  InvocationDispatchRequest,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationEventsSinceRequest,
  InvocationEventsSinceResponse,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
  InvocationPermissionRespondRequest,
  InvocationPermissionRespondResponse,
  InvocationRuntimeContext,
  InvocationSnapshot,
  InvocationSnapshotRequest,
  InvocationStartRequest,
  InvocationStartResponse,
  InvocationStatusRequest,
  InvocationStatusResponse,
  InvocationStopRequest,
  InvocationStopResponse,
  JsonRpcNotification,
  PermissionDecision,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import { EventIterator } from './event-iterator'
import { StdioTransport, type StdioTransportStartOptions } from './stdio-transport'
import type { BrokerJsonRpcTransport, CloseHandler } from './transport'
import { UnixSocketTransport } from './unix-socket-transport'

export interface ConnectUnixOptions {
  socketPath: string
  timeoutMs?: number | undefined
}

export type PermissionRequestHandler = (
  request: PermissionRequestParams
) => Promise<PermissionDecision>

export interface InvocationStartResult {
  invocationId: string
  response: InvocationStartResponse
  events: AsyncIterable<InvocationEventEnvelope>
}

export interface InvocationStartDispatchOptions {
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export class BrokerClient {
  #transport: BrokerJsonRpcTransport
  #events = new Map<string, EventIterator<InvocationEventEnvelope>>()
  #pendingEvents = new Map<string, InvocationEventEnvelope[]>()
  // Highest event seq already surfaced per invocation. Used to drop duplicates
  // when replayed (attach/eventsSince) events overlap live notifications.
  #lastEventSeq = new Map<string, number>()
  #permissionHandler: PermissionRequestHandler | undefined
  #closeHandlers = new Set<CloseHandler>()

  private constructor(transport: BrokerJsonRpcTransport) {
    this.#transport = transport
    this.#transport.onNotification((notification) => {
      this.#handleNotification(notification)
    })
    this.#transport.onRequest(async (request) => {
      if (request.method === 'invocation.permission.request') {
        return this.#handlePermissionRequest(request.params)
      }
      throw new Error(`Unsupported broker-to-client request: ${request.method}`)
    })
    this.#transport.onClose((error) => {
      this.#closeEventStreams()
      for (const handler of this.#closeHandlers) {
        handler(error)
      }
    })
  }

  static async start(opts: StdioTransportStartOptions): Promise<BrokerClient> {
    return new BrokerClient(await StdioTransport.start(opts))
  }

  /**
   * Connect to a long-lived broker over a Unix domain socket. Unlike
   * {@link start}, the broker is NOT owned by this client: {@link close}
   * destroys only the socket and leaves the broker process running.
   */
  static async connectUnix(opts: ConnectUnixOptions): Promise<BrokerClient> {
    return new BrokerClient(await UnixSocketTransport.connect(opts))
  }

  /** Wrap an already-established transport (e.g. for tests or custom channels). */
  static fromTransport(transport: BrokerJsonRpcTransport): BrokerClient {
    return new BrokerClient(transport)
  }

  hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    return this.#transport.request('broker.hello', req)
  }

  health(req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return this.#transport.request('broker.health', req)
  }

  async startInvocation(
    spec: HarnessInvocationSpec,
    initialInput?: InvocationInput,
    runtime?: InvocationRuntimeContext,
    lifecyclePolicy?: BrokerLifecyclePolicyOverlay
  ): Promise<InvocationStartResult> {
    return this.startInvocationFromRequest(
      initialInput === undefined ? { spec } : { spec, initialInput },
      {
        runtime,
        lifecyclePolicy,
      }
    )
  }

  async startInvocationFromRequest(
    request: InvocationStartRequest,
    dispatchEnvOrOptions?: Record<string, string> | InvocationStartDispatchOptions,
    runtime?: InvocationRuntimeContext
  ): Promise<InvocationStartResult> {
    const expectedInvocationId = request.spec.invocationId
    const expectedEvents =
      expectedInvocationId !== undefined ? this.#eventStream(expectedInvocationId) : undefined
    const options =
      dispatchEnvOrOptions !== undefined &&
      ('dispatchEnv' in dispatchEnvOrOptions ||
        'runtime' in dispatchEnvOrOptions ||
        'lifecyclePolicy' in dispatchEnvOrOptions)
        ? (dispatchEnvOrOptions as InvocationStartDispatchOptions)
        : {
            dispatchEnv: dispatchEnvOrOptions as Record<string, string> | undefined,
            runtime,
          }

    // invocation.start now carries the InvocationDispatchRequest envelope:
    // a verbatim startRequest plus optional per-invocation dispatchEnv/runtime/lifecyclePolicy.
    const dispatch: InvocationDispatchRequest = {
      startRequest: request,
      ...(options.dispatchEnv !== undefined ? { dispatchEnv: options.dispatchEnv } : {}),
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      ...(options.lifecyclePolicy !== undefined
        ? { lifecyclePolicy: options.lifecyclePolicy }
        : {}),
    }

    try {
      const response = await this.#transport.request<InvocationStartResponse>(
        'invocation.start',
        structuredClone(dispatch)
      )
      const events = expectedEvents ?? this.#eventStream(response.invocationId)
      return {
        invocationId: response.invocationId,
        response,
        events,
      }
    } catch (error) {
      if (expectedInvocationId !== undefined) {
        expectedEvents?.close()
        this.#events.delete(expectedInvocationId)
      }
      throw error
    }
  }

  input(req: InvocationInputRequest): Promise<InvocationInputResponse> {
    return this.#transport.request('invocation.input', req)
  }

  interrupt(req: InvocationInterruptRequest): Promise<InvocationInterruptResponse> {
    return this.#transport.request('invocation.interrupt', req)
  }

  stop(req: InvocationStopRequest): Promise<InvocationStopResponse> {
    return this.#transport.request('invocation.stop', req)
  }

  status(req: InvocationStatusRequest): Promise<InvocationStatusResponse> {
    return this.#transport.request('invocation.status', req)
  }

  async dispose(req: InvocationDisposeRequest): Promise<void> {
    await this.#transport.request('invocation.dispose', req)
    const events = this.#events.get(req.invocationId)
    events?.close()
    this.#events.delete(req.invocationId)
    this.#lastEventSeq.delete(req.invocationId)
  }

  // --- Protocol v2 (broker durability) methods ---------------------------
  // These delegate verbatim to the transport. Brokers that do not yet expose
  // the v2 control surface answer with method-not-found until Phase C lands.

  attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    return this.#transport.request('broker.attach', req)
  }

  eventsSince(req: InvocationEventsSinceRequest): Promise<InvocationEventsSinceResponse> {
    return this.#transport.request('invocation.eventsSince', req)
  }

  ackEvents(req: InvocationAckEventsRequest): Promise<InvocationAckEventsResponse> {
    return this.#transport.request('invocation.ackEvents', req)
  }

  snapshot(req: InvocationSnapshotRequest): Promise<InvocationSnapshot> {
    return this.#transport.request('invocation.snapshot', req)
  }

  /**
   * Settle a broker-owned pending permission request by permissionRequestId
   * (C2). Idempotent: a duplicate same-decision response replays the original
   * result; a different decision rejects with PermissionResponseConflict; an
   * expired or unknown id rejects with the corresponding Phase A error code.
   */
  permissionRespond(
    req: InvocationPermissionRespondRequest
  ): Promise<InvocationPermissionRespondResponse> {
    return this.#transport.request('invocation.permission.respond', req)
  }

  onPermissionRequest(handler: PermissionRequestHandler): void {
    this.#permissionHandler = handler
  }

  onClose(handler: CloseHandler): void {
    this.#closeHandlers.add(handler)
  }

  async close(): Promise<void> {
    this.#closeEventStreams()
    await this.#transport.close()
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'invocation.event') {
      return
    }

    // Permission decisions arrive ONLY as inbound 'invocation.permission.request'
    // JSON-RPC requests (handled in #handlePermissionRequest via onRequest).
    // permission.requested / permission.resolved are audit events surfaced
    // through the normal observable event stream below.
    const event = notification.params as InvocationEventEnvelope
    this.#ingestEvent(event)
  }

  /**
   * Surface an event to its stream, dropping duplicates by (invocationId, seq).
   * Replayed events (attach/eventsSince) can overlap live notifications; the
   * client de-dupes so a stream never sees the same seq twice or goes backwards.
   */
  #ingestEvent(event: InvocationEventEnvelope): void {
    const lastSeq = this.#lastEventSeq.get(event.invocationId)
    if (lastSeq !== undefined && event.seq <= lastSeq) {
      return
    }
    this.#lastEventSeq.set(event.invocationId, event.seq)

    const stream = this.#events.get(event.invocationId)
    if (stream) {
      stream.push(event)
      return
    }

    const pending = this.#pendingEvents.get(event.invocationId) ?? []
    pending.push(event)
    this.#pendingEvents.set(event.invocationId, pending)
  }

  #eventStream(invocationId: string): EventIterator<InvocationEventEnvelope> {
    const existing = this.#events.get(invocationId)
    if (existing) {
      return existing
    }

    const stream = new EventIterator<InvocationEventEnvelope>()
    this.#events.set(invocationId, stream)
    const pending = this.#pendingEvents.get(invocationId)
    if (pending) {
      this.#pendingEvents.delete(invocationId)
      for (const event of pending) {
        stream.push(event)
      }
    }
    return stream
  }

  async #handlePermissionRequest(params: unknown): Promise<PermissionDecision> {
    const request = params as PermissionRequestParams
    if (!this.#permissionHandler) {
      console.warn(
        `Broker permission request ${request.permissionRequestId} has no client handler; broker defaultDecision will apply.`
      )
      return { decision: request.defaultDecision ?? 'deny' }
    }

    try {
      return await this.#permissionHandler(request)
    } catch (error) {
      console.warn(
        `Broker permission handler failed for ${request.permissionRequestId}: ${
          error instanceof Error ? error.message : String(error)
        }; broker defaultDecision will apply.`
      )
      return { decision: request.defaultDecision ?? 'deny' }
    }
  }

  #closeEventStreams(): void {
    for (const events of this.#events.values()) {
      events.close()
    }
    this.#events.clear()
    this.#pendingEvents.clear()
    this.#lastEventSeq.clear()
  }
}
