import { createAgentSpacesClient } from 'agent-spaces'
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
import type { Broker } from 'spaces-harness-broker'
import type { InvocationDispatchRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompileDiagnostic,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DIAGNOSTIC_CODES, compilerDiagnostic, errorDetails, formatError } from './diagnostics.js'
import { selectBrokerProfile } from './profileSelector.js'

// Keep in sync with package.json `version`. The build's rootDir is `./src`, so
// the manifest cannot be imported directly without breaking emit; this single
// constant is the source of truth surfaced by `aspc.hello`.
const ASPC_FACADE_VERSION = '0.1.1'

const ASPC_COMPILE_AND_START_SCHEMA = 'aspc-compile-and-start-response/v1'
const ASPC_COMPILE_HARNESS_INVOCATION_SCHEMA = 'aspc-compile-harness-invocation-response/v1'
const RUNTIME_COMPILE_RESPONSE_SCHEMA = 'agent-runtime-compile-response/v1'

export type AspcCompiler = (
  req: RuntimeCompileRequest,
  options?: { aspHome?: string | undefined }
) => Promise<RuntimeCompileResponse>

export interface AspcServiceOptions {
  broker?: Broker | undefined
  compiler?: AspcCompiler | undefined
}

export interface AspcService {
  hello(req: AspcHelloRequest): Promise<AspcHelloResponse>
  compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse>
  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse>
  compileAndStart(req: AspcCompileAndStartRequest): Promise<AspcCompileAndStartResponse>
}

export function createAspcService(options: AspcServiceOptions = {}): AspcService {
  const compiler = options.compiler ?? defaultCompiler
  const broker = options.broker

  return {
    async hello(_req: AspcHelloRequest): Promise<AspcHelloResponse> {
      return {
        facadeInfo: {
          name: 'aspc-facade',
          version: ASPC_FACADE_VERSION,
        },
        protocolVersion: ASPC_PROTOCOL_VERSION,
        capabilities: {
          compileRuntimePlan: true,
          compileHarnessInvocation: true,
          compileAndStart: broker !== undefined,
          cohostedBroker: broker !== undefined,
          transports: ['stdio-jsonrpc-ndjson'],
        },
        ...(broker !== undefined ? { brokerProtocol: 'harness-broker/0.2' } : {}),
      }
    },

    async compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse> {
      return compileRuntimePlanSafe(compiler, req.compileRequest, req.aspHome)
    },

    async compileHarnessInvocation(
      req: AspcCompileHarnessInvocationRequest
    ): Promise<AspcCompileHarnessInvocationResponse> {
      return compileHarnessInvocation(compiler, req)
    },

    async compileAndStart(req: AspcCompileAndStartRequest): Promise<AspcCompileAndStartResponse> {
      if (broker === undefined) {
        throw new Error('aspc.compileAndStart requires a co-hosted broker')
      }

      const compile = await compileHarnessInvocation(compiler, req)
      if (!compile.ok) {
        return failCompileAndStart(compile)
      }

      const startResponse = await startFromDispatch(broker, compile.dispatchRequest)
      return {
        schemaVersion: ASPC_COMPILE_AND_START_SCHEMA,
        ok: true,
        compile,
        startResponse,
      }
    },
  }
}

/**
 * Spreads an `InvocationDispatchRequest` into the positional `Broker.start`
 * call shape. Single source for the arg order so the facade's broker-start row
 * and `compileAndStart` cannot drift apart. Internal-only — not re-exported.
 */
export function startFromDispatch(
  broker: Broker,
  dispatch: InvocationDispatchRequest
): ReturnType<Broker['start']> {
  return broker.start(
    dispatch.startRequest,
    dispatch.dispatchEnv,
    dispatch.runtime,
    dispatch.lifecyclePolicy
  )
}

async function defaultCompiler(
  req: RuntimeCompileRequest,
  options?: { aspHome?: string | undefined }
): Promise<RuntimeCompileResponse> {
  const client = createAgentSpacesClient({ aspHome: options?.aspHome })
  return client.compileRuntimePlan(req)
}

async function compileRuntimePlanSafe(
  compiler: AspcCompiler,
  req: RuntimeCompileRequest,
  aspHome: string | undefined
): Promise<RuntimeCompileResponse> {
  try {
    return await compiler(req, { aspHome })
  } catch (error) {
    return failRuntimeCompile([
      compilerDiagnostic(
        DIAGNOSTIC_CODES.compilerException,
        formatError(error),
        errorDetails(error)
      ),
    ])
  }
}

async function compileHarnessInvocation(
  compiler: AspcCompiler,
  req: AspcCompileHarnessInvocationRequest
): Promise<AspcCompileHarnessInvocationResponse> {
  const compileResponse = await compileRuntimePlanSafe(compiler, req.compileRequest, req.aspHome)
  if (!compileResponse.ok) {
    return failHarnessInvocation(compileResponse, compileResponse.diagnostics)
  }

  const selected = selectBrokerProfile(compileResponse.plan, req.profileSelector)
  if (!selected.ok) {
    const diagnostics = [...compileResponse.diagnostics, selected.diagnostic]
    return failHarnessInvocation(failRuntimeCompile(diagnostics), diagnostics)
  }

  const dispatchRequest = buildDispatchRequest(selected.profile, req)
  return {
    schemaVersion: ASPC_COMPILE_HARNESS_INVOCATION_SCHEMA,
    ok: true,
    compileResponse,
    plan: compileResponse.plan,
    selectedProfile: selected.profile,
    startRequest: selected.profile.harnessInvocation.startRequest,
    dispatchRequest,
    diagnostics: compileResponse.diagnostics,
  }
}

// The typed `placement` contract in spaces-runtime-contracts does not expose
// an optional `dispatchEnv`, so reach it through this named structural view.
type PlacementWithDispatchEnv = { dispatchEnv?: Record<string, string> | undefined }

function placementDispatchEnv(
  req: AspcCompileHarnessInvocationRequest
): Record<string, string> | undefined {
  return (req.compileRequest.placement as PlacementWithDispatchEnv).dispatchEnv
}

function buildDispatchRequest(
  profile: BrokerExecutionProfile,
  req: AspcCompileHarnessInvocationRequest
): InvocationDispatchRequest {
  const dispatchEnv = req.dispatchEnv ?? placementDispatchEnv(req)
  return {
    startRequest: profile.harnessInvocation.startRequest,
    ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
    ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
    ...(req.lifecyclePolicy !== undefined ? { lifecyclePolicy: req.lifecyclePolicy } : {}),
  }
}

function failRuntimeCompile(
  diagnostics: CompileDiagnostic[]
): Extract<RuntimeCompileResponse, { ok: false }> {
  return {
    schemaVersion: RUNTIME_COMPILE_RESPONSE_SCHEMA,
    ok: false,
    diagnostics,
  }
}

function failHarnessInvocation(
  compileResponse: RuntimeCompileResponse,
  diagnostics: CompileDiagnostic[]
): Extract<AspcCompileHarnessInvocationResponse, { ok: false }> {
  return {
    schemaVersion: ASPC_COMPILE_HARNESS_INVOCATION_SCHEMA,
    ok: false,
    compileResponse,
    diagnostics,
  }
}

function failCompileAndStart(
  compile: Extract<AspcCompileHarnessInvocationResponse, { ok: false }>
): Extract<AspcCompileAndStartResponse, { ok: false }> {
  return {
    schemaVersion: ASPC_COMPILE_AND_START_SCHEMA,
    ok: false,
    compile,
    diagnostics: compile.diagnostics,
  }
}
