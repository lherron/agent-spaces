import type {
  AspcCatalogAgentsRequest,
  AspcCatalogAgentsResponse,
  AspcCompileAndStartRequest,
  AspcCompileAndStartResponse,
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcCompileRuntimePlanRequest,
  AspcHelloRequest,
  AspcHelloResponse,
  AspcInspectAgentRequest,
  AspcInspectAgentResponse,
} from 'spaces-aspc-protocol'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import { StdioTransport } from 'spaces-harness-broker-client'
import type { StdioTransportStartOptions } from 'spaces-harness-broker-client'
import type { JsonRpcNotification, JsonRpcRequest } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileResponse } from 'spaces-runtime-contracts'

export type AspcRequestHandler = (request: JsonRpcRequest) => Promise<unknown>

export class AspcClient {
  #transport: StdioTransport
  #requestHandler: AspcRequestHandler | undefined
  #notificationHandler: ((notification: JsonRpcNotification) => void) | undefined

  private constructor(transport: StdioTransport) {
    this.#transport = transport
    this.#transport.onNotification((notification) => {
      this.#notificationHandler?.(notification)
    })
    this.#transport.onRequest(async (request) => {
      if (this.#requestHandler === undefined) {
        throw new Error(`Unsupported facade-to-client request: ${request.method}`)
      }
      return this.#requestHandler(request)
    })
  }

  static async start(options: StdioTransportStartOptions): Promise<AspcClient> {
    return new AspcClient(await StdioTransport.start(options))
  }

  hello(
    req: AspcHelloRequest = {
      clientInfo: { name: 'spaces-aspc-client' },
      protocolVersions: [ASPC_PROTOCOL_VERSION],
    }
  ): Promise<AspcHelloResponse> {
    return this.#transport.request('aspc.hello', req)
  }

  compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse> {
    return this.#transport.request('aspc.compileRuntimePlan', req)
  }

  catalogAgents(req: AspcCatalogAgentsRequest): Promise<AspcCatalogAgentsResponse> {
    return this.#transport.request('aspc.catalogAgents', req)
  }

  inspectAgent(req: AspcInspectAgentRequest): Promise<AspcInspectAgentResponse> {
    return this.#transport.request('aspc.inspectAgent', req)
  }

  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse> {
    return this.#transport.request('aspc.compileHarnessInvocation', req)
  }

  compileAndStart(req: AspcCompileAndStartRequest): Promise<AspcCompileAndStartResponse> {
    return this.#transport.request('aspc.compileAndStart', req)
  }

  request<T>(method: string, params?: unknown): Promise<T> {
    return this.#transport.request(method, params)
  }

  /**
   * Registers the single facade-to-client request handler. Single-registration
   * is intentional: a second call would silently disable the first handler
   * (last-writer-wins foot-gun), so double registration throws instead. Hosts
   * that need to fan out should compose their own dispatcher behind one handler.
   */
  onRequest(handler: AspcRequestHandler): void {
    if (this.#requestHandler !== undefined) {
      throw new Error('AspcClient.onRequest handler already registered')
    }
    this.#requestHandler = handler
  }

  /**
   * Registers the single facade-to-client notification handler. As with
   * {@link onRequest}, registration is single-shot: re-registering throws
   * rather than silently overwriting the prior handler.
   */
  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    if (this.#notificationHandler !== undefined) {
      throw new Error('AspcClient.onNotification handler already registered')
    }
    this.#notificationHandler = handler
  }

  async close(): Promise<void> {
    await this.#transport.close()
  }
}
