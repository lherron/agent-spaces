import type {
  AspcCompileAndStartRequest,
  AspcCompileAndStartResponse,
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcCompileRuntimePlanRequest,
  AspcHelloRequest,
  AspcHelloResponse,
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

  onRequest(handler: AspcRequestHandler): void {
    this.#requestHandler = handler
  }

  onNotification(handler: (notification: JsonRpcNotification) => void): void {
    this.#notificationHandler = handler
  }

  async close(): Promise<void> {
    await this.#transport.close()
  }
}
