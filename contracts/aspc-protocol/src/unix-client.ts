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
import type { RuntimeCompileResponse } from 'spaces-runtime-contracts'
import type {
  AspcAdmitDesktopRegistrationRequest,
  AspcAdmitDesktopRegistrationResponse,
  AspcAgentInspectionCatalogResponse,
  AspcCatalogAgentInspectionRequest,
  AspcCatalogAgentsRequest,
  AspcCatalogAgentsResponse,
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcCompileRuntimePlanRequest,
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
  AspcPrepareDesktopObserverRequest,
  AspcPrepareDesktopObserverResponse,
  AspcPrepareProcessInvocationRequest,
  AspcPrepareProcessInvocationResponse,
  AspcResolveDesktopIdentityRequest,
  AspcResolveDesktopIdentityResponse,
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
  timeoutMs?: number | undefined
}

export class AspcUnixClient {
  readonly socketPath: string
  readonly hello: AspcHelloResponse
  #transport: UnixSocketTransport

  private constructor(
    socketPath: string,
    transport: UnixSocketTransport,
    hello: AspcHelloResponse
  ) {
    this.socketPath = socketPath
    this.#transport = transport
    this.hello = hello
  }

  /** Connect and negotiate `aspc.hello`. Throws {@link AspcServiceUnavailableError} when nothing listens. */
  static async connect(options: AspcUnixClientConnectOptions): Promise<AspcUnixClient> {
    let transport: UnixSocketTransport
    try {
      transport = await UnixSocketTransport.connect({
        socketPath: options.socketPath,
        timeoutMs: options.timeoutMs ?? 5_000,
      })
    } catch (error) {
      if (error instanceof BrokerTransportError) {
        throw new AspcServiceUnavailableError(options.socketPath, error.causeError ?? error)
      }
      throw error
    }
    try {
      const hello = await transport.request<AspcHelloResponse>('aspc.hello', {
        clientInfo: options.clientInfo,
        protocolVersions: [ASPC_PROTOCOL_VERSION],
      } satisfies AspcHelloRequest)
      if (hello.protocolVersion !== ASPC_PROTOCOL_VERSION) {
        throw new AspcProtocolIncompatibleError(String(hello.protocolVersion))
      }
      return new AspcUnixClient(options.socketPath, transport, hello)
    } catch (error) {
      await transport.close()
      throw error
    }
  }

  compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse> {
    return this.#request('aspc.compileRuntimePlan', req)
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
    return this.#capabilityRequest('prepareProcessInvocation', 'aspc.prepareProcessInvocation', req)
  }

  resolveDesktopIdentity(
    req: AspcResolveDesktopIdentityRequest
  ): Promise<AspcResolveDesktopIdentityResponse> {
    return this.#capabilityRequest('resolveDesktopIdentity', 'aspc.resolveDesktopIdentity', req)
  }

  admitDesktopRegistration(
    req: AspcAdmitDesktopRegistrationRequest
  ): Promise<AspcAdmitDesktopRegistrationResponse> {
    return this.#capabilityRequest('admitDesktopRegistration', 'aspc.admitDesktopRegistration', req)
  }

  prepareDesktopObserver(
    req: AspcPrepareDesktopObserverRequest
  ): Promise<AspcPrepareDesktopObserverResponse> {
    return this.#capabilityRequest('prepareDesktopObserver', 'aspc.prepareDesktopObserver', req)
  }

  #capabilityRequest<T>(capability: string, method: string, params: unknown): Promise<T> {
    if ((this.hello.capabilities as Record<string, unknown>)[capability] !== true) {
      throw new AspcCapabilityMissingError(capability)
    }
    return this.#request<T>(method, params)
  }

  async #request<T>(method: string, params: unknown): Promise<T> {
    try {
      return await this.#transport.request<T>(method, params)
    } catch (error) {
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
