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
        return failCompileAndStart(compile)
      }

      const dispatch = compile.dispatchRequest
      const startResponse = await broker.start(
        dispatch.startRequest,
        dispatch.dispatchEnv,
        dispatch.runtime,
        dispatch.lifecyclePolicy
      )
      return {
        schemaVersion: ASPC_COMPILE_AND_START_SCHEMA,
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
    return failRuntimeCompile([
      compilerDiagnostic('compiler_exception', formatError(error), errorDetails(error)),
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

function selectBrokerProfile(
  plan: Extract<RuntimeCompileResponse, { ok: true }>['plan'],
  selector: AspcCompileHarnessInvocationRequest['profileSelector']
): { ok: true; profile: BrokerExecutionProfile } | { ok: false; diagnostic: CompileDiagnostic } {
  const brokerProfiles = plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )

  // Driven by a table so a new selector dimension is added by appending one
  // entry (Open/Closed): each criterion narrows the candidate list only when
  // the corresponding selector key is provided.
  const profiles = SELECTOR_CRITERIA.reduce((candidates, { field }) => {
    const expected = selector?.[field]
    if (expected === undefined) {
      return candidates
    }
    return candidates.filter((profile) => profile[field] === expected)
  }, brokerProfiles)

  // A single matched profile is always returned. `profiles[0]` is non-undefined
  // whenever `length === 1`, so rely on the length check directly rather than a
  // redundant `!== undefined` guard that could otherwise let the single-match
  // case fall through to the `broker_profile_missing` diagnostic below.
  if (profiles.length === 1) {
    return { ok: true, profile: profiles[0] as BrokerExecutionProfile }
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

type ProfileSelector = NonNullable<AspcCompileHarnessInvocationRequest['profileSelector']>

// Selector key ↔ profile field pairs. The keys are intentionally shared so a
// new dimension is one extra entry rather than another `if (...)` block.
const SELECTOR_CRITERIA: ReadonlyArray<{
  field: keyof ProfileSelector & keyof BrokerExecutionProfile
}> = [{ field: 'profileId' }, { field: 'profileHash' }, { field: 'brokerDriver' }]

function placementDispatchEnv(
  req: AspcCompileHarnessInvocationRequest
): Record<string, string> | undefined {
  return (req.compileRequest.placement as { dispatchEnv?: Record<string, string> | undefined })
    .dispatchEnv
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
