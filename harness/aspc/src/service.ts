import {
  admitDesktopRegistration,
  catalogAgentsForContext,
  createAgentSpacesClient,
  inspectAgentForContext,
  inspectRuntimePlacement,
  observeContinuationArtifact,
  observeRuntimeCapability,
  prepareDesktopObserver,
  resolveDesktopIdentity,
  resolveRuntimeDeclaration,
} from 'agent-spaces'
import type {
  AspcAdmitDesktopRegistrationRequest,
  AspcAdmitDesktopRegistrationResponse,
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
  AspcInspectRuntimePlacementRequest,
  AspcInspectRuntimePlacementResponse,
  AspcObserveContinuationArtifactRequest,
  AspcObserveContinuationArtifactResponse,
  AspcObserveRuntimeCapabilityRequest,
  AspcObserveRuntimeCapabilityResponse,
  AspcPrepareDesktopObserverRequest,
  AspcPrepareDesktopObserverResponse,
  AspcPrepareProcessInvocationRequest,
  AspcPrepareProcessInvocationResponse,
  AspcResolveDesktopIdentityRequest,
  AspcResolveDesktopIdentityResponse,
  AspcResolveRuntimeDeclarationRequest,
  AspcResolveRuntimeDeclarationResponse,
} from 'spaces-aspc-protocol'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type { InvocationDispatchRequest } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompileContext,
  CompileDiagnostic,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import packageManifest from '../package.json'
import {
  type AspcInspectionAuthorityOptions,
  createAspcInspectionAuthority,
} from './agent-inspection-authority.js'
import { DIAGNOSTIC_CODES, compilerDiagnostic, errorDetails, formatError } from './diagnostics.js'
import { selectBrokerProfile } from './profileSelector.js'

const ASPC_FACADE_VERSION: string = packageManifest.version

const ASPC_COMPILE_HARNESS_INVOCATION_SCHEMA = 'aspc-compile-harness-invocation-response/v1'
const RUNTIME_COMPILE_RESPONSE_SCHEMA = 'agent-runtime-compile-response/v1'

export type AspcCompiler = (
  req: RuntimeCompileRequest,
  options?: { aspHome?: string | undefined; compileContext?: CompileContext | undefined }
) => Promise<RuntimeCompileResponse>

export interface AspcServiceOptions {
  compiler?: AspcCompiler | undefined
  agentsRoot?: AspcInspectionAuthorityOptions['agentsRoot']
  resolveProjectRoot?: AspcInspectionAuthorityOptions['resolveProjectRoot']
  environment?: AspcInspectionAuthorityOptions['environment'] | Record<string, string | undefined>
  now?: AspcInspectionAuthorityOptions['now']
  serviceProbeResponses?: AspcInspectionAuthorityOptions['serviceProbeResponses']
  scaffoldPackets?: AspcInspectionAuthorityOptions['scaffoldPackets']
  runtimeDependencies?: NonNullable<Parameters<typeof createAgentSpacesClient>[0]>['runtime']
}

export interface AspcService {
  hello(req: AspcHelloRequest): Promise<AspcHelloResponse>
  compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse>
  catalogAgents(req: AspcCatalogAgentsRequest): Promise<AspcCatalogAgentsResponse>
  inspectAgent(req: AspcInspectAgentRequest): Promise<AspcInspectAgentResponse>
  catalogAgentInspection(
    req: AspcCatalogAgentInspectionRequest
  ): Promise<AspcAgentInspectionCatalogResponse>
  inspectAgentSelection(req: AspcInspectAgentSelectionRequest): Promise<AspcInspectAgentResponse>
  compileHarnessInvocation(
    req: AspcCompileHarnessInvocationRequest
  ): Promise<AspcCompileHarnessInvocationResponse>
  resolveRuntimeDeclaration(
    req: AspcResolveRuntimeDeclarationRequest
  ): Promise<AspcResolveRuntimeDeclarationResponse>
  inspectRuntimePlacement(
    req: AspcInspectRuntimePlacementRequest
  ): Promise<AspcInspectRuntimePlacementResponse>
  observeRuntimeCapability(
    req: AspcObserveRuntimeCapabilityRequest
  ): Promise<AspcObserveRuntimeCapabilityResponse>
  observeContinuationArtifact(
    req: AspcObserveContinuationArtifactRequest
  ): Promise<AspcObserveContinuationArtifactResponse>
  prepareProcessInvocation(
    req: AspcPrepareProcessInvocationRequest
  ): Promise<AspcPrepareProcessInvocationResponse>
  resolveDesktopIdentity(
    req: AspcResolveDesktopIdentityRequest
  ): Promise<AspcResolveDesktopIdentityResponse>
  admitDesktopRegistration(
    req: AspcAdmitDesktopRegistrationRequest
  ): Promise<AspcAdmitDesktopRegistrationResponse>
  prepareDesktopObserver(
    req: AspcPrepareDesktopObserverRequest
  ): Promise<AspcPrepareDesktopObserverResponse>
}

export function createAspcService(options: AspcServiceOptions = {}): AspcService {
  const compiler = options.compiler ?? defaultCompiler
  const inspectionAuthority = createAspcInspectionAuthority(compiler, {
    ...(options.agentsRoot ? { agentsRoot: options.agentsRoot } : {}),
    ...(options.resolveProjectRoot ? { resolveProjectRoot: options.resolveProjectRoot } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.serviceProbeResponses
      ? { serviceProbeResponses: options.serviceProbeResponses }
      : {}),
    ...(options.scaffoldPackets ? { scaffoldPackets: options.scaffoldPackets } : {}),
    ...(options.environment
      ? {
          environment:
            typeof options.environment === 'function'
              ? options.environment
              : () => options.environment as Record<string, string | undefined>,
        }
      : {}),
  })

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
          catalogAgents: true,
          inspectAgent: true,
          catalogAgentInspection: true,
          inspectAgentSelection: true,
          compileHarnessInvocation: true,
          resolveRuntimeDeclaration: true,
          inspectRuntimePlacement: true,
          inspectRuntimePlacementPreparationCorrelation: true,
          observeRuntimeCapability: true,
          observeContinuationArtifact: true,
          compileAndStart: false,
          prepareProcessInvocation: true,
          resolveDesktopIdentity: true,
          admitDesktopRegistration: true,
          prepareDesktopObserver: true,
          cohostedBroker: false,
          transports: ['stdio-jsonrpc-ndjson'],
        },
      }
    },

    async compileRuntimePlan(req: AspcCompileRuntimePlanRequest): Promise<RuntimeCompileResponse> {
      return compileRuntimePlanSafe(compiler, req.compileRequest, req.aspHome, req.compileContext)
    },

    async prepareProcessInvocation(req) {
      const client = createAgentSpacesClient({
        aspHome: req.context.agentSources?.aspHome ?? serviceEnvironment(options)['ASP_HOME'],
        runtime: options.runtimeDependencies,
      })
      return client.prepareProcessInvocation(req) as Promise<AspcPrepareProcessInvocationResponse>
    },

    async resolveDesktopIdentity(req) {
      return resolveDesktopIdentity(req) as Promise<AspcResolveDesktopIdentityResponse>
    },

    async admitDesktopRegistration(req) {
      return admitDesktopRegistration(req) as Promise<AspcAdmitDesktopRegistrationResponse>
    },

    async prepareDesktopObserver(req) {
      return prepareDesktopObserver(req) as Promise<AspcPrepareDesktopObserverResponse>
    },

    async catalogAgents(req: AspcCatalogAgentsRequest): Promise<AspcCatalogAgentsResponse> {
      return catalogAgentsForContext(req)
    },

    async inspectAgent(req: AspcInspectAgentRequest): Promise<AspcInspectAgentResponse> {
      return inspectAgentForContext(req, {
        compileRuntimePlan: (compileRequest, compileOptions) =>
          compiler(compileRequest, {
            compileContext: compileOptions?.compileContext,
          }),
      })
    },

    async catalogAgentInspection(
      req: AspcCatalogAgentInspectionRequest
    ): Promise<AspcAgentInspectionCatalogResponse> {
      return inspectionAuthority.catalogAgentInspection(req)
    },

    async inspectAgentSelection(
      req: AspcInspectAgentSelectionRequest
    ): Promise<AspcInspectAgentResponse> {
      return inspectionAuthority.inspectAgentSelection(req)
    },

    async compileHarnessInvocation(
      req: AspcCompileHarnessInvocationRequest
    ): Promise<AspcCompileHarnessInvocationResponse> {
      return compileHarnessInvocation(compiler, req)
    },

    async resolveRuntimeDeclaration(req) {
      return resolveRuntimeDeclaration(
        req,
        runtimeDeclarationOptions(options)
      ) as Promise<AspcResolveRuntimeDeclarationResponse>
    },

    async inspectRuntimePlacement(req) {
      const serviceProbeResponses = options.serviceProbeResponses?.()
      const scaffoldPackets = options.scaffoldPackets?.()
      return inspectRuntimePlacement(req, {
        ...runtimeDeclarationOptions(options),
        ...(serviceProbeResponses ? { serviceProbeResponses } : {}),
        ...(scaffoldPackets ? { scaffoldPackets } : {}),
        compileRuntimePlan: (
          compileRequest: RuntimeCompileRequest,
          compileOptions?: { compileContext?: CompileContext | undefined }
        ) => compiler(compileRequest, { compileContext: compileOptions?.compileContext }),
      }) as Promise<AspcInspectRuntimePlacementResponse>
    },

    async observeRuntimeCapability(req) {
      return observeRuntimeCapability(req) as Promise<AspcObserveRuntimeCapabilityResponse>
    },

    async observeContinuationArtifact(req) {
      const environment = serviceEnvironment(options)
      return observeContinuationArtifact(req, {
        ...(environment?.['ASP_HOME'] ? { aspHome: environment['ASP_HOME'] } : {}),
      }) as Promise<AspcObserveContinuationArtifactResponse>
    },
  }
}

function runtimeDeclarationOptions(options: AspcServiceOptions) {
  const environment = serviceEnvironment(options)
  return {
    ...(options.agentsRoot ? { agentsRoot: options.agentsRoot } : {}),
    ...(environment['ASP_HOME'] ? { aspHome: environment['ASP_HOME'] } : {}),
    environment,
    ...(options.now ? { now: () => new Date(options.now?.() ?? new Date().toISOString()) } : {}),
  }
}

function serviceEnvironment(options: AspcServiceOptions): Record<string, string | undefined> {
  return typeof options.environment === 'function'
    ? options.environment()
    : (options.environment ?? process.env)
}

async function defaultCompiler(
  req: RuntimeCompileRequest,
  options?: { aspHome?: string | undefined; compileContext?: CompileContext | undefined }
): Promise<RuntimeCompileResponse> {
  const client = createAgentSpacesClient({ aspHome: options?.aspHome })
  return client.compileRuntimePlan(
    req,
    options?.compileContext !== undefined ? { compileContext: options.compileContext } : undefined
  )
}

async function compileRuntimePlanSafe(
  compiler: AspcCompiler,
  req: RuntimeCompileRequest,
  aspHome: string | undefined,
  compileContext?: CompileContext | undefined
): Promise<RuntimeCompileResponse> {
  try {
    return await compiler(req, {
      aspHome,
      ...(compileContext !== undefined ? { compileContext } : {}),
    })
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
  const compileResponse = await compileRuntimePlanSafe(
    compiler,
    req.compileRequest,
    req.aspHome,
    req.compileContext
  )
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
    ...(compileResponse.effectiveEnvironmentHash !== undefined
      ? { effectiveEnvironmentHash: compileResponse.effectiveEnvironmentHash }
      : {}),
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
