import type {
  BrokerLifecyclePolicyOverlay,
  InvocationDispatchRequest,
  InvocationRuntimeContext,
  InvocationStartResponse,
  JsonRpcRequest,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompileDiagnostic,
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

export const ASPC_PROTOCOL_VERSION = 'aspc/0.1' as const

export type AspcProtocolVersion = typeof ASPC_PROTOCOL_VERSION

/**
 * `schemaVersion` discriminators for ASPC response envelopes. Named here so the
 * literals are not copy-pasted across the success/failure branches of each
 * response union below.
 */
export const ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION =
  'aspc-compile-harness-invocation-response/v1' as const
export const ASPC_COMPILE_AND_START_RESPONSE_VERSION = 'aspc-compile-and-start-response/v1' as const

/**
 * Single source of truth for the set of `aspc.*` methods. `AspcMethod`, the
 * runtime predicate, and the validator dispatch table are all derived from this
 * tuple so a new method cannot drift out of sync across those surfaces.
 */
export const ASPC_METHODS = [
  'aspc.hello',
  'aspc.compileRuntimePlan',
  'aspc.compileHarnessInvocation',
  'aspc.compileAndStart',
] as const

export type AspcMethod = (typeof ASPC_METHODS)[number]

export type AspcCommand =
  | JsonRpcRequest<'aspc.hello', AspcHelloRequest>
  | JsonRpcRequest<'aspc.compileRuntimePlan', AspcCompileRuntimePlanRequest>
  | JsonRpcRequest<'aspc.compileHarnessInvocation', AspcCompileHarnessInvocationRequest>
  | JsonRpcRequest<'aspc.compileAndStart', AspcCompileAndStartRequest>

export interface AspcHelloRequest {
  clientInfo: {
    name: string
    version?: string | undefined
  }
  protocolVersions: string[]
  capabilities?:
    | {
        compileRuntimePlan?: boolean | undefined
        compileHarnessInvocation?: boolean | undefined
        compileAndStart?: boolean | undefined
      }
    | undefined
}

export interface AspcHelloResponse {
  facadeInfo: {
    name: 'aspc-facade'
    version: string
  }
  protocolVersion: AspcProtocolVersion
  capabilities: {
    compileRuntimePlan: true
    compileHarnessInvocation: true
    compileAndStart: boolean
    cohostedBroker: boolean
    transports: ['stdio-jsonrpc-ndjson']
  }
  brokerProtocol?: 'harness-broker/0.2' | undefined
}

export interface AspcCompileRuntimePlanRequest {
  compileRequest: RuntimeCompileRequest
  aspHome?: string | undefined
}

export type AspcProfileSelector = {
  profileId?: string | undefined
  profileHash?: string | undefined
  brokerDriver?: string | undefined
}

export interface AspcCompileHarnessInvocationRequest extends AspcCompileRuntimePlanRequest {
  profileSelector?: AspcProfileSelector | undefined
  dispatchEnv?: Record<string, string> | undefined
  runtime?: InvocationRuntimeContext | undefined
  lifecyclePolicy?: BrokerLifecyclePolicyOverlay | undefined
}

export type AspcCompileHarnessInvocationResponse =
  | {
      schemaVersion: typeof ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION
      ok: true
      compileResponse: Extract<RuntimeCompileResponse, { ok: true }>
      plan: CompiledRuntimePlan
      selectedProfile: BrokerExecutionProfile
      startRequest: BrokerExecutionProfile['harnessInvocation']['startRequest']
      dispatchRequest: InvocationDispatchRequest
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: typeof ASPC_COMPILE_HARNESS_INVOCATION_RESPONSE_VERSION
      ok: false
      compileResponse: RuntimeCompileResponse
      diagnostics: CompileDiagnostic[]
    }

export type AspcCompileAndStartRequest = AspcCompileHarnessInvocationRequest

export type AspcCompileAndStartResponse =
  | {
      schemaVersion: typeof ASPC_COMPILE_AND_START_RESPONSE_VERSION
      ok: true
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: true }>
      startResponse: InvocationStartResponse
    }
  | {
      schemaVersion: typeof ASPC_COMPILE_AND_START_RESPONSE_VERSION
      ok: false
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: false }>
      diagnostics: CompileDiagnostic[]
    }
