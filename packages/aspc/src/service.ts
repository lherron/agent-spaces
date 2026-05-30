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

const ASPC_FACADE_VERSION = '0.1.0'

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
        ...(broker !== undefined ? { brokerProtocol: 'harness-broker/0.1' } : {}),
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
        return {
          schemaVersion: 'aspc-compile-and-start-response/v1',
          ok: false,
          compile,
          diagnostics: compile.diagnostics,
        }
      }

      const dispatch = compile.dispatchRequest
      const startResponse = await broker.start(
        dispatch.startRequest,
        dispatch.dispatchEnv,
        dispatch.runtime
      )
      return {
        schemaVersion: 'aspc-compile-and-start-response/v1',
        ok: true,
        compile,
        startResponse,
      }
    },
  }
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
    return {
      schemaVersion: 'agent-runtime-compile-response/v1',
      ok: false,
      diagnostics: [
        compilerDiagnostic('compiler_exception', formatError(error), errorDetails(error)),
      ],
    }
  }
}

async function compileHarnessInvocation(
  compiler: AspcCompiler,
  req: AspcCompileHarnessInvocationRequest
): Promise<AspcCompileHarnessInvocationResponse> {
  const compileResponse = await compileRuntimePlanSafe(compiler, req.compileRequest, req.aspHome)
  if (!compileResponse.ok) {
    return {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1',
      ok: false,
      compileResponse,
      diagnostics: compileResponse.diagnostics,
    }
  }

  const selected = selectBrokerProfile(compileResponse.plan, req.profileSelector)
  if (!selected.ok) {
    const diagnostics = [...compileResponse.diagnostics, selected.diagnostic]
    return {
      schemaVersion: 'aspc-compile-harness-invocation-response/v1',
      ok: false,
      compileResponse: {
        schemaVersion: 'agent-runtime-compile-response/v1',
        ok: false,
        diagnostics,
      },
      diagnostics,
    }
  }

  const dispatchRequest = buildDispatchRequest(selected.profile, req)
  return {
    schemaVersion: 'aspc-compile-harness-invocation-response/v1',
    ok: true,
    compileResponse,
    plan: compileResponse.plan,
    selectedProfile: selected.profile,
    startRequest: selected.profile.harnessInvocation.startRequest,
    dispatchRequest,
    diagnostics: compileResponse.diagnostics,
  }
}

function selectBrokerProfile(
  plan: Extract<RuntimeCompileResponse, { ok: true }>['plan'],
  selector: AspcCompileHarnessInvocationRequest['profileSelector']
): { ok: true; profile: BrokerExecutionProfile } | { ok: false; diagnostic: CompileDiagnostic } {
  let profiles = plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  if (selector?.profileId !== undefined) {
    profiles = profiles.filter((profile) => profile.profileId === selector.profileId)
  }
  if (selector?.profileHash !== undefined) {
    profiles = profiles.filter((profile) => profile.profileHash === selector.profileHash)
  }
  if (selector?.brokerDriver !== undefined) {
    profiles = profiles.filter((profile) => profile.brokerDriver === selector.brokerDriver)
  }

  if (profiles.length === 1) {
    const profile = profiles[0]
    if (profile !== undefined) {
      return { ok: true, profile }
    }
  }

  if (profiles.length === 0) {
    return {
      ok: false,
      diagnostic: compilerDiagnostic(
        'broker_profile_missing',
        'No harness-broker profile matched the ASPC selector',
        {
          selector,
          profileCount: plan.executionProfiles.length,
        }
      ),
    }
  }

  return {
    ok: false,
    diagnostic: compilerDiagnostic(
      'broker_profile_ambiguous',
      'Multiple harness-broker profiles matched the ASPC selector',
      {
        selector,
        matchedProfiles: profiles.map((profile) => ({
          profileId: profile.profileId,
          profileHash: profile.profileHash,
          brokerDriver: profile.brokerDriver,
        })),
      }
    ),
  }
}

function buildDispatchRequest(
  profile: BrokerExecutionProfile,
  req: AspcCompileHarnessInvocationRequest
): InvocationDispatchRequest {
  const placementDispatchEnv = (
    req.compileRequest.placement as { dispatchEnv?: Record<string, string> | undefined }
  ).dispatchEnv
  const dispatchEnv = req.dispatchEnv ?? placementDispatchEnv
  return {
    startRequest: profile.harnessInvocation.startRequest,
    ...(dispatchEnv !== undefined ? { dispatchEnv } : {}),
    ...(req.runtime !== undefined ? { runtime: req.runtime } : {}),
  }
}

function compilerDiagnostic(code: string, message: string, details?: unknown): CompileDiagnostic {
  return {
    level: 'error',
    code,
    message,
    plane: 'asp-compiler',
    ...(details !== undefined ? { details } : {}),
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function errorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, stack: error.stack }
  }
  return error
}
