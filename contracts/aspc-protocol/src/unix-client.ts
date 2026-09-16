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
    return this.#transport.request('aspc.compileRuntimePlan', req)
  }

  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse> {
    return this.#transport.request('aspc.compileHarnessInvocation', req)
  }

  catalogAgents(req: AspcCatalogAgentsRequest): Promise<AspcCatalogAgentsResponse> {
    return this.#transport.request('aspc.catalogAgents', req)
  }

  inspectAgent(req: AspcInspectAgentRequest): Promise<AspcInspectAgentResponse> {
    return this.#transport.request('aspc.inspectAgent', req)
  }

  catalogAgentInspection(
    req: AspcCatalogAgentInspectionRequest = {}
  ): Promise<AspcAgentInspectionCatalogResponse> {
    return this.#transport.request('aspc.catalogAgentInspection', req)
  }

  inspectAgentSelection(req: AspcInspectAgentSelectionRequest): Promise<AspcInspectAgentResponse> {
    return this.#transport.request('aspc.inspectAgentSelection', req)
  }

  onClose(handler: CloseHandler): void {
    this.#transport.onClose(handler)
  }

  close(): Promise<void> {
    return this.#transport.close()
  }
}
