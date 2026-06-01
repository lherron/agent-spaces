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

export type AspcMethod =
  | 'aspc.hello'
  | 'aspc.compileRuntimePlan'
  | 'aspc.compileHarnessInvocation'
  | 'aspc.compileAndStart'

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
  brokerProtocol?: 'harness-broker/0.1' | undefined
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
      schemaVersion: 'aspc-compile-harness-invocation-response/v1'
      ok: true
      compileResponse: Extract<RuntimeCompileResponse, { ok: true }>
      plan: CompiledRuntimePlan
      selectedProfile: BrokerExecutionProfile
      startRequest: BrokerExecutionProfile['harnessInvocation']['startRequest']
      dispatchRequest: InvocationDispatchRequest
      diagnostics: CompileDiagnostic[]
    }
  | {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1'
      ok: false
      compileResponse: RuntimeCompileResponse
      diagnostics: CompileDiagnostic[]
    }

export interface AspcCompileAndStartRequest extends AspcCompileHarnessInvocationRequest {}

export type AspcCompileAndStartResponse =
  | {
      schemaVersion: 'aspc-compile-and-start-response/v1'
      ok: true
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: true }>
      startResponse: InvocationStartResponse
    }
  | {
      schemaVersion: 'aspc-compile-and-start-response/v1'
      ok: false
      compile: Extract<AspcCompileHarnessInvocationResponse, { ok: false }>
      diagnostics: CompileDiagnostic[]
    }
