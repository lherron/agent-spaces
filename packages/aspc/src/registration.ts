/**
 * Transport-injected registration of the ASPC COMPILE plane (T-07314).
 *
 * `spaces-aspc` is compile-only: it owns no JSON-RPC transport of its own (the
 * concrete NDJSON server lives in `spaces-harness-broker`, which this package
 * deliberately does not depend on). Instead it binds its seven compile methods
 * onto any caller-supplied server object that can `register(method, handler)` —
 * the co-hosted composition facade passes a real `ProtocolServer`, and a raspc
 * binary can pass its own transport.
 */
import {
  validateAspcCatalogAgentInspectionRequest,
  validateAspcCatalogAgentsRequest,
  validateAspcCommand,
  validateAspcCompileHarnessInvocationRequest,
  validateAspcCompileRuntimePlanRequest,
  validateAspcHelloRequest,
  validateAspcInspectAgentRequest,
  validateAspcInspectAgentSelectionRequest,
} from 'spaces-aspc-protocol'
import type { AspcService } from './service.js'
import { createAspcService } from './service.js'

export const JSONRPC_VERSION = '2.0'

/** The compile-plane wire names, in one place rather than at each call site. */
export const ASPC_COMPILE_METHODS = {
  hello: 'aspc.hello',
  compileRuntimePlan: 'aspc.compileRuntimePlan',
  catalogAgents: 'aspc.catalogAgents',
  inspectAgent: 'aspc.inspectAgent',
  catalogAgentInspection: 'aspc.catalogAgentInspection',
  inspectAgentSelection: 'aspc.inspectAgentSelection',
  compileHarnessInvocation: 'aspc.compileHarnessInvocation',
} as const

export type AspcMethodRequest = {
  id: string | number | null
  method: string
  params: unknown
}

export type AspcMethodHandler = (request: AspcMethodRequest) => Promise<unknown>

/**
 * The injected transport seam: anything that can take a named handler. Kept
 * structural on purpose so `spaces-aspc` never names a concrete server type.
 */
export interface AspcMethodServer {
  register(method: string, handler: AspcMethodHandler): void
}

export interface RegisterAspcCompileMethodsOptions {
  service?: AspcService | undefined
}

/**
 * Registers one ASPC route: validate the JSON-RPC envelope, narrow params with
 * the method's typed validator, then forward to the service. Exported so the
 * composition package registers `aspc.compileAndStart` through the same seam.
 */
export function registerAspcMethod<Params, Result>(
  server: AspcMethodServer,
  method: string,
  validateRequest: (params: unknown) => Params,
  handle: (req: Params) => Promise<Result>
): void {
  server.register(method, async ({ id, params }) => {
    validateAspcCommand({ jsonrpc: JSONRPC_VERSION, id, method, params })
    return handle(validateRequest(params))
  })
}

/**
 * Binds exactly the seven compile methods onto `server`. Registers no
 * `aspc.compileAndStart`, no `broker.*` and no `invocation.*` route: the start
 * plane belongs to the co-hosted composition facade.
 */
export function registerAspcCompileMethods(
  server: AspcMethodServer,
  options: RegisterAspcCompileMethodsOptions = {}
): void {
  const service = options.service ?? createAspcService()

  registerAspcMethod(server, ASPC_COMPILE_METHODS.hello, validateAspcHelloRequest, (req) =>
    service.hello(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.compileRuntimePlan,
    validateAspcCompileRuntimePlanRequest,
    (req) => service.compileRuntimePlan(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.catalogAgents,
    validateAspcCatalogAgentsRequest,
    (req) => service.catalogAgents(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.inspectAgent,
    validateAspcInspectAgentRequest,
    (req) => service.inspectAgent(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.catalogAgentInspection,
    validateAspcCatalogAgentInspectionRequest,
    (req) => service.catalogAgentInspection(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.inspectAgentSelection,
    validateAspcInspectAgentSelectionRequest,
    (req) => service.inspectAgentSelection(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.compileHarnessInvocation,
    validateAspcCompileHarnessInvocationRequest,
    (req) => service.compileHarnessInvocation(req)
  )
}
