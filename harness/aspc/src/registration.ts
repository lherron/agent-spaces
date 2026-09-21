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
  validateAspcHelloRequest,
  validateAspcInspectAgentRequest,
  validateAspcInspectAgentSelectionRequest,
  validateAspcInspectRuntimePlacementRequest,
  validateAspcObserveContinuationArtifactRequest,
  validateAspcObserveRuntimeCapabilityRequest,
  validateAspcPrepareProcessInvocationRequest,
  validateAspcResolveRuntimeDeclarationRequest,
} from 'spaces-aspc-protocol'
import type { AspcService } from './service.js'
import { createAspcService } from './service.js'

export const JSONRPC_VERSION = '2.0'

/** The compile-plane wire names, in one place rather than at each call site. */
export const ASPC_COMPILE_METHODS = {
  hello: 'aspc.hello',
  catalogAgents: 'aspc.catalogAgents',
  inspectAgent: 'aspc.inspectAgent',
  catalogAgentInspection: 'aspc.catalogAgentInspection',
  inspectAgentSelection: 'aspc.inspectAgentSelection',
  compileHarnessInvocation: 'aspc.compileHarnessInvocation',
  resolveRuntimeDeclaration: 'aspc.resolveRuntimeDeclaration',
  inspectRuntimePlacement: 'aspc.inspectRuntimePlacement',
  observeRuntimeCapability: 'aspc.observeRuntimeCapability',
  observeContinuationArtifact: 'aspc.observeContinuationArtifact',
  prepareProcessInvocation: 'aspc.prepareProcessInvocation',
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
 * the method's typed validator, then forward to the service.
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
 * Binds the ASPC read/compile methods onto `server`. It registers no broker or
 * invocation route: starting an invocation is a separate broker operation that
 * receives the canonical dispatch request from `compileHarnessInvocation`.
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
  registerAspcObservationMethod(
    server,
    ASPC_COMPILE_METHODS.resolveRuntimeDeclaration,
    validateAspcResolveRuntimeDeclarationRequest,
    (req) => service.resolveRuntimeDeclaration(req)
  )
  registerAspcObservationMethod(
    server,
    ASPC_COMPILE_METHODS.inspectRuntimePlacement,
    validateAspcInspectRuntimePlacementRequest,
    (req) => service.inspectRuntimePlacement(req)
  )
  registerAspcObservationMethod(
    server,
    ASPC_COMPILE_METHODS.observeRuntimeCapability,
    validateAspcObserveRuntimeCapabilityRequest,
    (req) => service.observeRuntimeCapability(req)
  )
  registerAspcObservationMethod(
    server,
    ASPC_COMPILE_METHODS.observeContinuationArtifact,
    validateAspcObserveContinuationArtifactRequest,
    (req) => service.observeContinuationArtifact(req)
  )
  registerAspcMethod(
    server,
    ASPC_COMPILE_METHODS.prepareProcessInvocation,
    validateAspcPrepareProcessInvocationRequest,
    (req) => service.prepareProcessInvocation(req)
  )
}

function registerAspcObservationMethod<Params, Result>(
  server: AspcMethodServer,
  method: string,
  validateRequest: (params: unknown) => Params,
  handle: (req: Params) => Promise<Result>
): void {
  server.register(method, async ({ id, params }) => {
    try {
      validateAspcCommand({ jsonrpc: JSONRPC_VERSION, id, method, params })
      return handle(validateRequest(params))
    } catch (error) {
      const schema =
        typeof params === 'object' && params !== null
          ? (params as Record<string, unknown>)['schemaVersion']
          : undefined
      if (typeof schema === 'string' && schema !== expectedObservationSchema(method)) {
        return handle(params as Params)
      }
      throw error
    }
  })
}

function expectedObservationSchema(method: string): string {
  switch (method) {
    case ASPC_COMPILE_METHODS.resolveRuntimeDeclaration:
      return 'aspc-resolve-runtime-declaration-request/v1'
    case ASPC_COMPILE_METHODS.inspectRuntimePlacement:
      return 'aspc-inspect-runtime-placement-request/v1'
    case ASPC_COMPILE_METHODS.observeRuntimeCapability:
      return 'aspc-observe-runtime-capability-request/v1'
    case ASPC_COMPILE_METHODS.observeContinuationArtifact:
      return 'aspc-observe-continuation-artifact-request/v1'
    default:
      return ''
  }
}
