import type {
  BrokerAttachRequest,
  BrokerAttachResponse,
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  BrokerLifecyclePolicyOverlay,
  BrokerListInvocationsRequest,
  BrokerListInvocationsResponse,
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
} from 'spaces-harness-broker-protocol'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'
import { InvocationEventHub } from './invocation-event-hub'
import { type PermissionRequestHandler, PermissionRouter } from './permission-router'
import { StdioTransport, type StdioTransportStartOptions } from './stdio-transport'
import type { BrokerJsonRpcTransport, CloseHandler } from './transport'
import { UnixSocketTransport } from './unix-socket-transport'

export interface ConnectUnixOptions {
  socketPath: string
  timeoutMs?: number | undefined
}

export type { PermissionRequestHandler }

/**
 * Unsubscribe callback returned by handler-registration methods
 * ({@link BrokerClient.onClose}, {@link BrokerClient.onPermissionRequest}).
 * Calling it removes the handler; calling it more than once is a no-op.
 */
export type Disposer = () => void

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
  #eventHub = new InvocationEventHub()
  #permissions = new PermissionRouter()
  #closeHandlers = new Set<CloseHandler>()

  private constructor(transport: BrokerJsonRpcTransport) {
    this.#transport = transport
    this.#transport.onNotification((notification) => {
      this.#handleNotification(notification)
    })
    this.#transport.onRequest(async (request) => {
      if (request.method === 'invocation.permission.request') {
        return this.#permissions.handle(request.params)
      }
      throw new Error(`Unsupported broker-to-client request: ${request.method}`)
    })
    this.#transport.onClose((error) => {
      this.#eventHub.closeAll()
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

  async hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    const response = await this.#transport.request<BrokerHelloResponse>('broker.hello', req)
    const negotiated = response.protocolVersion
    if (!(SUPPORTED_BROKER_PROTOCOL_VERSIONS as readonly string[]).includes(negotiated)) {
      throw new Error(
        `broker selected unsupported protocol version: ${negotiated} (supported: ${SUPPORTED_BROKER_PROTOCOL_VERSIONS.join(
          ', '
        )})`
      )
    }
    return response
  }

  health(req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return this.#transport.request('broker.health', req)
  }

  listInvocations(req: BrokerListInvocationsRequest): Promise<BrokerListInvocationsResponse> {
    return this.#transport.request('broker.listInvocations', req)
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
      expectedInvocationId !== undefined ? this.#eventHub.stream(expectedInvocationId) : undefined
    const options = this.#normalizeDispatchOptions(dispatchEnvOrOptions, runtime)
    const dispatch = this.#buildDispatch(request, options)

    try {
      // `dispatch` was just assembled from caller-owned fragments and is not
      // mutated below; the transport serializes it to NDJSON rather than
      // retaining it, so no defensive copy is needed here.
      const response = await this.#transport.request<InvocationStartResponse>(
        'invocation.start',
        dispatch
      )
      const events = expectedEvents ?? this.#eventHub.stream(response.invocationId)
      return {
        invocationId: response.invocationId,
        response,
        events,
      }
    } catch (error) {
      if (expectedInvocationId !== undefined) {
        expectedEvents?.close()
        this.#eventHub.drop(expectedInvocationId)
      }
      throw error
    }
  }

  /**
   * Resolve the positional-overload arg into a single
   * {@link InvocationStartDispatchOptions}. The second positional may be either
   * a bare `dispatchEnv` map or a full options object; the latter is recognized
   * by the presence of any options-only key.
   */
  #normalizeDispatchOptions(
    dispatchEnvOrOptions: Record<string, string> | InvocationStartDispatchOptions | undefined,
    runtime: InvocationRuntimeContext | undefined
  ): InvocationStartDispatchOptions {
    if (
      dispatchEnvOrOptions !== undefined &&
      ('dispatchEnv' in dispatchEnvOrOptions ||
        'runtime' in dispatchEnvOrOptions ||
        'lifecyclePolicy' in dispatchEnvOrOptions)
    ) {
      return dispatchEnvOrOptions as InvocationStartDispatchOptions
    }
    return {
      dispatchEnv: dispatchEnvOrOptions as Record<string, string> | undefined,
      runtime,
    }
  }

  /**
   * Assemble the `invocation.start` envelope: a verbatim startRequest plus any
   * per-invocation dispatchEnv/runtime/lifecyclePolicy overrides.
   */
  #buildDispatch(
    request: InvocationStartRequest,
    options: InvocationStartDispatchOptions
  ): InvocationDispatchRequest {
    return {
      startRequest: request,
      ...(options.dispatchEnv !== undefined ? { dispatchEnv: options.dispatchEnv } : {}),
      ...(options.runtime !== undefined ? { runtime: options.runtime } : {}),
      ...(options.lifecyclePolicy !== undefined
        ? { lifecyclePolicy: options.lifecyclePolicy }
        : {}),
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
    this.#eventHub.dispose(req.invocationId)
  }

  // --- Protocol v2 (broker durability) methods ---------------------------
  // These delegate verbatim to the transport. Brokers that do not yet expose
  // the v2 control surface answer with method-not-found until Phase C lands.

  attach(req: BrokerAttachRequest): Promise<BrokerAttachResponse> {
    return this.#transport.request('broker.attach', req)
  }

  /**
   * Live event stream for an ALREADY-ATTACHED invocation (durability reattach).
   * `startInvocationFromRequest` returns its own stream for an invocation it
   * launched; a controller that re-attached over `broker.attach` has none, so
   * this exposes the per-invocation `EventIterator`. Opening it drains any live
   * notifications buffered since the attach and then yields all future ones,
   * de-duped by `(invocationId, seq)` in `InvocationEventHub.ingest`.
   * Closed on transport close / dispose with the rest of the streams.
   */
  streamInvocationEvents(invocationId: string): AsyncIterable<InvocationEventEnvelope> {
    return this.#eventHub.stream(invocationId)
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

  /**
   * Register the single inbound-permission handler. Last-writer-wins: a second
   * registration replaces the previous handler. Returns a {@link Disposer} that
   * clears the handler (a no-op once it has been superseded).
   */
  onPermissionRequest(handler: PermissionRequestHandler): Disposer {
    return this.#permissions.setHandler(handler)
  }

  /**
   * Register a transport-close handler. Multiple handlers may be registered and
   * all fire on close. Returns a {@link Disposer} that removes this handler so a
   * long-lived client does not accrue handlers for its full lifetime.
   */
  onClose(handler: CloseHandler): Disposer {
    this.#closeHandlers.add(handler)
    return () => {
      this.#closeHandlers.delete(handler)
    }
  }

  async close(): Promise<void> {
    this.#eventHub.closeAll()
    await this.#transport.close()
  }

  #handleNotification(notification: JsonRpcNotification): void {
    if (notification.method !== 'invocation.event') {
      return
    }

    // Permission decisions arrive ONLY as inbound 'invocation.permission.request'
    // JSON-RPC requests (handled by PermissionRouter via onRequest).
    // permission.requested / permission.resolved are audit events surfaced
    // through the normal observable event stream below.
    const event = notification.params as InvocationEventEnvelope
    this.#eventHub.ingest(event)
  }
}
