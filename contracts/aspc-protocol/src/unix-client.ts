/**
 * Thin Unix-socket client for the existing `aspc.*` compile plane (T-08539).
 *
 * Wire types, NDJSON JSON-RPC framing and transport only: it carries no ASP
 * configuration, compiler, materialization or execution code, so a host (HRC)
 * can speak to `aspd` without importing the implementation it prepares with.
 *
 * Deliberately never retries. Every connection negotiates `aspc.hello` first and
 * exposes the serving release; a closed connection fails its pending requests
 * and the caller decides whether to connect again and resubmit.
 */
import { BrokerTransportError, UnixSocketTransport } from 'spaces-harness-broker-client'
import type { CloseHandler } from 'spaces-harness-broker-client'
import type {
  AspcAgentInspectionCatalogResponse,
  AspcCatalogAgentInspectionRequest,
  AspcCatalogAgentsRequest,
  AspcCatalogAgentsResponse,
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcHelloRequest,
  AspcHelloResponse,
  AspcInspectAgentRequest,
  AspcInspectAgentResponse,
  AspcInspectAgentSelectionRequest,
  AspcInspectRuntimePlacementRequest,
  AspcInspectRuntimePlacementResponse,
  AspcObserveContinuationArtifactRequest,
  AspcObserveContinuationArtifactResponse,
  AspcObserveRuntimeCapabilityRequest,
  AspcObserveRuntimeCapabilityResponse,
  AspcPrepareProcessInvocationRequest,
  AspcPrepareProcessInvocationResponse,
  AspcResolveRuntimeDeclarationRequest,
  AspcResolveRuntimeDeclarationResponse,
} from './types.js'
import { ASPC_PROTOCOL_VERSION } from './types.js'

/** No listener answered the configured socket. Nothing was sent. */
export class AspcServiceUnavailableError extends Error {
  readonly code = 'aspc_service_unavailable'
  readonly socketPath: string
  readonly causeError: unknown

  constructor(socketPath: string, causeError: unknown) {
    super(`ASPC service unavailable at ${socketPath}`)
    this.name = 'AspcServiceUnavailableError'
    this.socketPath = socketPath
    this.causeError = causeError
  }
}

/**
 * The connection closed before this request was answered. The transport cannot
 * tell whether the service acted on it; the client does not retry.
 */
export class AspcConnectionClosedError extends Error {
  readonly code = 'aspc_connection_closed'
  readonly method: string

  constructor(method: string, causeError: unknown) {
    super(
      `ASPC connection closed before ${method} was answered (${causeError instanceof Error ? causeError.message : String(causeError)})`
    )
    this.name = 'AspcConnectionClosedError'
    this.method = method
  }
}

/** The service answered hello with a protocol this client does not speak. */
export class AspcProtocolIncompatibleError extends Error {
  readonly code = 'aspc_protocol_incompatible'
  readonly offered: string

  constructor(offered: string) {
    super(`ASPC service negotiated unsupported protocol ${offered}`)
    this.name = 'AspcProtocolIncompatibleError'
    this.offered = offered
  }
}

/**
 * The service accepted the request but did not answer before the deadline. The
 * client closes its socket on expiry: the service may still act on the request,
 * and the caller decides whether to connect again (R-00307).
 */
export class AspcRequestTimeoutError extends Error {
  readonly code = 'aspc_request_timeout'
  readonly method: string
  readonly timeoutMs: number

  constructor(method: string, timeoutMs: number) {
    super(`ASPC service did not answer ${method} within ${timeoutMs}ms`)
    this.name = 'AspcRequestTimeoutError'
    this.method = method
    this.timeoutMs = timeoutMs
  }
}

export class AspcCapabilityMissingError extends Error {
  readonly code = 'missing_capability'
  constructor(readonly capability: string) {
    super(`ASPC capability missing: ${capability}`)
    this.name = 'AspcCapabilityMissingError'
  }
}

export interface AspcUnixClientConnectOptions {
  socketPath: string
  clientInfo: AspcHelloRequest['clientInfo']
  /** Deadline for connect AND the `aspc.hello` negotiation together (default 5s). */
  timeoutMs?: number | undefined
  /** Deadline for each later request; unbounded when omitted. Expiry closes the client. */
  requestTimeoutMs?: number | undefined
}

export class AspcUnixClient {
  readonly socketPath: string
  readonly hello: AspcHelloResponse
  #transport: UnixSocketTransport
  #requestTimeoutMs: number | undefined

  private constructor(
    socketPath: string,
    transport: UnixSocketTransport,
    hello: AspcHelloResponse,
    requestTimeoutMs: number | undefined
  ) {
    this.socketPath = socketPath
    this.#transport = transport
    this.hello = hello
    this.#requestTimeoutMs = requestTimeoutMs
  }

  /** Connect and negotiate `aspc.hello`. Throws {@link AspcServiceUnavailableError} when nothing listens. */
  static async connect(options: AspcUnixClientConnectOptions): Promise<AspcUnixClient> {
    const timeoutMs = options.timeoutMs ?? 5_000
    const deadline = performance.now() + timeoutMs
    let transport: UnixSocketTransport
    try {
      transport = await UnixSocketTransport.connect({ socketPath: options.socketPath, timeoutMs })
    } catch (error) {
      if (error instanceof BrokerTransportError) {
        throw new AspcServiceUnavailableError(options.socketPath, error.causeError ?? error)
      }
      throw error
    }
    try {
      const negotiation = transport.request<AspcHelloResponse>('aspc.hello', {
        clientInfo: options.clientInfo,
        protocolVersions: [ASPC_PROTOCOL_VERSION],
      } satisfies AspcHelloRequest)
      // timeoutMs <= 0 keeps the transport's "no deadline" meaning.
      const hello =
        timeoutMs > 0
          ? await withDeadline(
              negotiation,
              'aspc.hello',
              timeoutMs,
              Math.max(1, deadline - performance.now())
            )
          : await negotiation
      if (hello.protocolVersion !== ASPC_PROTOCOL_VERSION) {
        throw new AspcProtocolIncompatibleError(String(hello.protocolVersion))
      }
      return new AspcUnixClient(options.socketPath, transport, hello, options.requestTimeoutMs)
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse> {
    return this.#request('aspc.compileHarnessInvocation', req)
  }

  catalogAgents(req: AspcCatalogAgentsRequest): Promise<AspcCatalogAgentsResponse> {
    return this.#request('aspc.catalogAgents', req)
  }

  inspectAgent(req: AspcInspectAgentRequest): Promise<AspcInspectAgentResponse> {
    return this.#request('aspc.inspectAgent', req)
  }

  catalogAgentInspection(
    req: AspcCatalogAgentInspectionRequest = {}
  ): Promise<AspcAgentInspectionCatalogResponse> {
    return this.#request('aspc.catalogAgentInspection', req)
  }

  inspectAgentSelection(req: AspcInspectAgentSelectionRequest): Promise<AspcInspectAgentResponse> {
    return this.#request('aspc.inspectAgentSelection', req)
  }

  resolveRuntimeDeclaration(
    req: AspcResolveRuntimeDeclarationRequest
  ): Promise<AspcResolveRuntimeDeclarationResponse> {
    return this.#request('aspc.resolveRuntimeDeclaration', req)
  }

  inspectRuntimePlacement(
    req: AspcInspectRuntimePlacementRequest
  ): Promise<AspcInspectRuntimePlacementResponse> {
    // T-08579: never send preparationCorrelation to a producer that did not
    // advertise it; the caller must fail closed rather than inspect uncorrelated.
    // T-09860: likewise for the producer task context.
    if (req.preparationTaskContext !== undefined) {
      return this.#capabilityRequest(
        'inspectRuntimePlacementPreparationTaskContext',
        'aspc.inspectRuntimePlacement',
        req
      )
    }
    if (req.preparationCorrelation !== undefined) {
      return this.#capabilityRequest(
        'inspectRuntimePlacementPreparationCorrelation',
        'aspc.inspectRuntimePlacement',
        req
      )
    }
    return this.#request('aspc.inspectRuntimePlacement', req)
  }

  observeRuntimeCapability(
    req: AspcObserveRuntimeCapabilityRequest
  ): Promise<AspcObserveRuntimeCapabilityResponse> {
    return this.#request('aspc.observeRuntimeCapability', req)
  }

  observeContinuationArtifact(
    req: AspcObserveContinuationArtifactRequest
  ): Promise<AspcObserveContinuationArtifactResponse> {
    return this.#request('aspc.observeContinuationArtifact', req)
  }

  prepareProcessInvocation(
    req: AspcPrepareProcessInvocationRequest
  ): Promise<AspcPrepareProcessInvocationResponse> {
    if (req.taskContext !== undefined) {
      return this.#capabilityRequest(
        'prepareProcessInvocationTaskContext',
        'aspc.prepareProcessInvocation',
        req
      )
    }
    return this.#capabilityRequest('prepareProcessInvocation', 'aspc.prepareProcessInvocation', req)
  }

  #capabilityRequest<T>(capability: string, method: string, params: unknown): Promise<T> {
    if ((this.hello.capabilities as Record<string, unknown>)[capability] !== true) {
      throw new AspcCapabilityMissingError(capability)
    }
    return this.#request<T>(method, params)
  }

  async #request<T>(method: string, params: unknown): Promise<T> {
    const pending = this.#transport.request<T>(method, params)
    try {
      if (this.#requestTimeoutMs === undefined) return await pending
      return await withDeadline(pending, method, this.#requestTimeoutMs, this.#requestTimeoutMs)
    } catch (error) {
      if (error instanceof AspcRequestTimeoutError) await this.#transport.close()
      if (error instanceof BrokerTransportError) throw new AspcConnectionClosedError(method, error)
      throw error
    }
  }

  onClose(handler: CloseHandler): void {
    this.#transport.onClose(handler)
  }

  close(): Promise<void> {
    return this.#transport.close()
  }
}

/** Reject with {@link AspcRequestTimeoutError} if `pending` has not settled within `remainingMs`. */
async function withDeadline<T>(
  pending: Promise<T>,
  method: string,
  timeoutMs: number,
  remainingMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AspcRequestTimeoutError(method, timeoutMs)), remainingMs)
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    clearTimeout(timer)
  }
}
