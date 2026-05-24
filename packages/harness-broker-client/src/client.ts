import type {
  BrokerHealthRequest,
  BrokerHealthResponse,
  BrokerHelloRequest,
  BrokerHelloResponse,
  HarnessInvocationSpec,
  InvocationDisposeRequest,
  InvocationEventEnvelope,
  InvocationInput,
  InvocationInputRequest,
  InvocationInputResponse,
  InvocationInterruptRequest,
  InvocationInterruptResponse,
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
import { StdioTransport, type CloseHandler, type StdioTransportStartOptions } from './stdio-transport'

export type PermissionRequestHandler = (
  request: PermissionRequestParams
) => Promise<PermissionDecision>

export interface InvocationStartResult {
  invocationId: string
  response: InvocationStartResponse
  events: AsyncIterable<InvocationEventEnvelope>
}

export class BrokerClient {
  #transport: StdioTransport
  #events = new Map<string, EventIterator<InvocationEventEnvelope>>()
  #pendingEvents = new Map<string, InvocationEventEnvelope[]>()
  #permissionHandler: PermissionRequestHandler | undefined
  #closeHandlers = new Set<CloseHandler>()

  private constructor(transport: StdioTransport) {
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

  hello(req: BrokerHelloRequest): Promise<BrokerHelloResponse> {
    return this.#transport.request('broker.hello', req)
  }

  health(req: BrokerHealthRequest = {}): Promise<BrokerHealthResponse> {
    return this.#transport.request('broker.health', req)
  }

  async startInvocation(
    spec: HarnessInvocationSpec,
    initialInput?: InvocationInput
  ): Promise<InvocationStartResult> {
    return this.startInvocationFromRequest(
      initialInput === undefined ? { spec } : { spec, initialInput }
    )
  }

  async startInvocationFromRequest(request: InvocationStartRequest): Promise<InvocationStartResult> {
    const expectedInvocationId = request.spec.invocationId
    const expectedEvents =
      expectedInvocationId !== undefined ? this.#eventStream(expectedInvocationId) : undefined

    try {
      const response = await this.#transport.request<InvocationStartResponse>(
        'invocation.start',
        structuredClone(request)
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
  }
}
