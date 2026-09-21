import { isAbsolute } from 'node:path'

import { buildCodexAppServerLaunchDescriptor, normalizeAgentSdkModel } from 'spaces-config'
import type { RuntimePlacement } from 'spaces-config'
// Internal legacy seam (EN-15986): the pre-cutover routing catalog, frozen
// for old v1 consumers. T-08702 deletes it with the last v1 consumer.
import {
  HARNESS_PROVIDERS,
  type HarnessId as LegacyHarnessId,
  getHarnessCatalogEntry,
  getHarnessFrontendsForProvider,
} from 'spaces-config/internal/legacy-harness'
import {
  toHarnessBrokerStartRequest,
  validateBrokerInvocationRequest,
} from './broker-invocation.js'
import {
  collectHooks,
  collectLintWarnings,
  collectTools,
  materializeSpec,
  resolveSpecToLock,
  validateSpec,
} from './client-materialization.js'
import {
  AGENT_SDK_FRONTEND,
  CodedError,
  FRONTEND_DEFS,
  assertProviderMatch,
  formatDisplayCommand,
  resolveFrontend,
  resolveModel,
} from './client-support.js'
import { compileRuntimePlan } from './compile-runtime-plan.js'
import type { AgentSpacesClientOptions } from './placement-api.js'
import { requireAgentSpacesRuntime } from './placement-api.js'
import {
  PreparationContextMismatchError,
  placementFromDeclaration,
  promptSourcesForDeclaration,
  resolvePreparationIdentity,
} from './preparation-execution-context.js'
import {
  type PreparePlacementCliRuntimeRequest,
  preparePlacementCliRuntime,
  toProcessInvocationSpec,
} from './prepare-cli-runtime.js'
import { resolveRuntimeDeclaration } from './runtime-declaration.js'
import type {
  AgentSpacesClient,
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  HostCorrelation,
  InvocationSpecBuilder,
  ProcessInvocationSpec,
  ProviderDomain,
  ResolveRequest,
  ResolveResponse,
  RuntimeCompiler,
  SpaceResolver,
} from './types.js'

type CompilerAgentSpacesClient = AgentSpacesClient & {
  prepareProcessInvocation(req: PrepareProcessInvocationRequest): Promise<Record<string, unknown>>
}
type CompilerImplementation = RuntimeCompiler &
  SpaceResolver &
  InvocationSpecBuilder & {
    prepareProcessInvocation(req: PrepareProcessInvocationRequest): Promise<Record<string, unknown>>
  }

type PrepareProcessInvocationRequest = {
  context: {
    agentId: string
    agentRoot?: string | undefined
    cwd: string
    runMode: 'query' | 'heartbeat' | 'task' | 'maintenance'
    project:
      | { mode: 'root'; projectRoot: string; projectId?: string | undefined }
      | { mode: 'infer-from-cwd' }
      | { mode: 'none' }
    agentSources?: { aspHome?: string | undefined; agentsRoot?: string | undefined } | undefined
    [key: string]: unknown
  }
  preparationCorrelation: HostCorrelation
  expected?: { provider?: string; frontend?: string } | undefined
  launch: {
    interactionMode: 'interactive' | 'headless'
    ioMode: 'pty' | 'inherit' | 'pipes'
    model?: string | undefined
    modelReasoningEffort?: string | undefined
    continuation?: HarnessContinuationRef | undefined
    prompt?: string | undefined
    omitPriming?: boolean | undefined
    attachments?: BuildProcessInvocationSpecRequest['attachments'] | undefined
    yolo?: boolean | undefined
  }
  dispatchEnv?: Record<string, string> | undefined
  lockedEnv?: Record<string, string> | undefined
  artifactDir?: string | undefined
}

type SuccessfulDeclaration = {
  ok: true
  provisioning: {
    effectiveHarness?: string | undefined
    declaredHarness?: string | undefined
    scalars: Record<string, string | number | boolean>
  }
  placement: RuntimePlacement
  agentSources: Record<string, unknown>
  markerProjectId?: string | undefined
}

async function withAspHome<T>(aspHome: string, fn: () => Promise<T>): Promise<T> {
  const aspHomeKey = 'ASP_HOME'
  const prior = process.env[aspHomeKey]
  process.env[aspHomeKey] = aspHome
  try {
    return await fn()
  } finally {
    if (prior === undefined) {
      delete process.env[aspHomeKey]
    } else {
      process.env[aspHomeKey] = prior
    }
  }
}

export function createAgentSpacesClient(
  options?: AgentSpacesClientOptions
): CompilerAgentSpacesClient {
  const clientAspHome = options?.aspHome
  const clientRegistryPath = options?.registryPath
  const clientRuntime = options?.runtime

  const client: CompilerImplementation = {
    async prepareProcessInvocation(req) {
      const declaration = (await resolveRuntimeDeclaration(
        {
          schemaVersion: 'aspc-resolve-runtime-declaration-request/v1',
          context: req.context,
        },
        {
          ...(clientAspHome ? { aspHome: clientAspHome } : {}),
          ...(req.context?.agentSources?.agentsRoot
            ? { agentsRoot: req.context.agentSources.agentsRoot }
            : {}),
        }
      )) as Record<string, unknown>
      if (declaration['ok'] !== true) {
        return {
          ...declaration,
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
        }
      }
      const resolved = declaration as unknown as SuccessfulDeclaration
      // Old v1 routing still needs provider/frontend: resolve them from the
      // internal legacy seam by exact canonical harness id (EN-15986).
      // An undeclared harness stays absent here; T-08702 migrates this
      // consumer off the seam entirely.
      const effectiveHarness = resolved.provisioning.effectiveHarness
      if (typeof effectiveHarness !== 'string') {
        return {
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
          ok: false,
          failure: {
            kind: 'incompatible',
            code: 'undeclared_harness',
            message: 'No harness is declared; refusing to invent a v1 routing default',
          },
        }
      }
      let legacyEntry: { provider: ProviderDomain; frontend?: unknown }
      try {
        legacyEntry = getHarnessCatalogEntry(effectiveHarness as LegacyHarnessId)
      } catch {
        return {
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
          ok: false,
          failure: {
            kind: 'incompatible',
            code: 'unsupported_harness',
            message: `Unsupported harness ${effectiveHarness}`,
          },
        }
      }
      if (typeof legacyEntry.frontend !== 'string') {
        return {
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
          ok: false,
          failure: {
            kind: 'incompatible',
            code: 'unsupported_harness',
            message: `Unsupported harness ${effectiveHarness}`,
          },
        }
      }
      const provider = legacyEntry.provider
      const frontend = legacyEntry.frontend as BuildProcessInvocationSpecRequest['frontend']
      const placement = placementFromDeclaration(
        resolved.placement,
        req.context,
        req.preparationCorrelation
      )
      const identityHints = {
        agentId: req.context.agentId,
        projectId: resolved.markerProjectId,
        taskId: typeof req.context['taskId'] === 'string' ? req.context['taskId'] : undefined,
      }
      try {
        resolvePreparationIdentity(placement, identityHints)
      } catch (error) {
        if (error instanceof PreparationContextMismatchError) {
          return {
            schemaVersion: 'aspc-prepare-process-invocation-response/v1',
            ok: false,
            failure: { kind: 'incompatible', code: error.code, message: error.message },
          }
        }
        throw error
      }
      try {
        const invocationRequest = {
          placement,
          provider,
          frontend,
          interactionMode: req.launch.interactionMode,
          ioMode: req.launch.ioMode,
          ...(req.launch.model !== undefined ? { model: req.launch.model } : {}),
          ...(req.launch.modelReasoningEffort !== undefined
            ? { modelReasoningEffort: req.launch.modelReasoningEffort }
            : {}),
          ...(req.launch.continuation !== undefined
            ? { continuation: req.launch.continuation }
            : {}),
          ...(req.launch.prompt !== undefined ? { prompt: req.launch.prompt } : {}),
          ...(req.launch.omitPriming !== undefined ? { omitPriming: req.launch.omitPriming } : {}),
          ...(req.launch.attachments !== undefined ? { attachments: req.launch.attachments } : {}),
          ...(req.launch.yolo !== undefined ? { yolo: req.launch.yolo } : {}),
          ...(req.dispatchEnv !== undefined ? { dispatchEnv: req.dispatchEnv } : {}),
          ...(req.lockedEnv !== undefined ? { lockedEnv: req.lockedEnv } : {}),
          ...(req.artifactDir !== undefined ? { artifactDir: req.artifactDir } : {}),
          promptSources: promptSourcesForDeclaration(resolved.agentSources),
          identityHints,
        } as unknown as BuildProcessInvocationSpecRequest &
          Pick<PreparePlacementCliRuntimeRequest, 'promptSources' | 'identityHints'>
        const prepared = await preparePlacementCliRuntime(
          invocationRequest,
          clientAspHome,
          clientRegistryPath,
          requireAgentSpacesRuntime(clientRuntime)
        )
        const invocation = toProcessInvocationSpec(prepared, invocationRequest)
        if (req.expected?.provider !== provider || req.expected?.frontend !== frontend) {
          return {
            schemaVersion: 'aspc-prepare-process-invocation-response/v1',
            ok: false,
            failure: {
              kind: 'incompatible',
              code: 'declaration_changed',
              message: `Resolved declaration is ${provider}/${frontend}, not ${req.expected?.provider}/${req.expected?.frontend}`,
            },
          }
        }
        return {
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
          ok: true,
          ...invocation,
          declaration: {
            provider,
            frontend,
            agentSources: resolved.agentSources,
          },
          effectiveEnvironmentHash: prepared.preparation.effectiveEnvironmentHash,
          diagnostics: [],
        }
      } catch (error) {
        return {
          schemaVersion: 'aspc-prepare-process-invocation-response/v1',
          ok: false,
          failure: {
            kind: 'unavailable',
            code: 'preparation_failed',
            message: error instanceof Error ? error.message : String(error),
          },
        }
      }
    },

    async compileRuntimePlan(req, options) {
      return compileRuntimePlan(req, {
        clientAspHome,
        clientRegistryPath,
        clientRuntime,
        ...(options?.compileContext !== undefined
          ? { compileContext: options.compileContext }
          : {}),
        ...(options?.materializeCodexRuntimeHome !== undefined
          ? { materializeCodexRuntimeHome: options.materializeCodexRuntimeHome }
          : {}),
      })
    },

    async resolve(req: ResolveRequest): Promise<ResolveResponse> {
      return withAspHome(req.aspHome, async () => {
        try {
          const spec = validateSpec(req.spec)
          await resolveSpecToLock(spec, req.aspHome, {
            registryPathOverride: clientRegistryPath,
          })
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            error: {
              message: error instanceof Error ? error.message : String(error),
              code: 'resolve_failed',
              ...(error instanceof Error && error.stack ? { details: { stack: error.stack } } : {}),
            },
          }
        }
      })
    },

    async describe(req: DescribeRequest): Promise<DescribeResponse> {
      return withAspHome(req.aspHome, async () => {
        const spec = validateSpec(req.spec)
        const frontendDef = req.frontend
          ? resolveFrontend(req.frontend)
          : resolveFrontend(AGENT_SDK_FRONTEND)
        const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId, {
          registryPathOverride: req.registryPath ?? clientRegistryPath,
          runtime: requireAgentSpacesRuntime(clientRuntime),
        })
        const hooks = await collectHooks(materialized.materialization.pluginDirs)
        const tools = await collectTools(materialized.materialization.mcpConfigPath)
        const lintWarnings =
          req.runLint === true
            ? await collectLintWarnings(spec, req.aspHome, req.registryPath ?? clientRegistryPath)
            : undefined
        const response: DescribeResponse = {
          hooks,
          skills: materialized.skills,
          tools,
        }

        if (lintWarnings) {
          response.lintWarnings = lintWarnings
        }

        if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
          const modelResolution = resolveModel(frontendDef, req.model)
          if (!modelResolution.ok) {
            throw new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            )
          }
          const plugins = materialized.materialization.pluginDirs.map((dir) => ({
            type: 'local' as const,
            path: dir,
          }))
          response.agentSdkSessionParams = [
            { paramName: 'kind', paramValue: 'agent-sdk' },
            { paramName: 'sessionId', paramValue: req.hostSessionId ?? null },
            { paramName: 'cwd', paramValue: req.cwd ?? null },
            { paramName: 'model', paramValue: normalizeAgentSdkModel(modelResolution.info.model) },
            { paramName: 'plugins', paramValue: plugins },
            { paramName: 'permissionHandler', paramValue: 'auto-allow' },
          ]
        }

        return response
      })
    },

    async getHarnessCapabilities(): Promise<HarnessCapabilities> {
      return {
        harnesses: HARNESS_PROVIDERS.map((provider) => {
          const frontends = getHarnessFrontendsForProvider(provider) as HarnessFrontend[]
          return {
            id: provider,
            provider,
            frontends,
            models: frontends.flatMap((frontend) => FRONTEND_DEFS.get(frontend)?.models ?? []),
          }
        }),
      }
    },

    async buildProcessInvocationSpec(
      req: BuildProcessInvocationSpecRequest
    ): Promise<BuildProcessInvocationSpecResponse> {
      if (req.placement) {
        const prepared = await preparePlacementCliRuntime(
          req,
          clientAspHome,
          clientRegistryPath,
          requireAgentSpacesRuntime(clientRuntime)
        )
        return toProcessInvocationSpec(prepared, req)
      }

      return withAspHome(req.aspHome, async () => {
        const warnings: string[] = []
        const spec = validateSpec(req.spec)

        if (!isAbsolute(req.cwd)) {
          throw new Error('cwd must be an absolute path')
        }

        const frontendDef = resolveFrontend(req.frontend)

        if (req.provider !== frontendDef.provider) {
          throw new CodedError(
            `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`,
            'provider_mismatch'
          )
        }

        assertProviderMatch(frontendDef, req.continuation)

        const modelResolution = resolveModel(frontendDef, req.model)
        if (!modelResolution.ok) {
          throw new Error(
            `Model not supported for frontend ${req.frontend}: ${modelResolution.modelId}`
          )
        }

        const runtime = requireAgentSpacesRuntime(clientRuntime)
        const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId, {
          registryPathOverride: clientRegistryPath,
          runtime,
        })
        const adapter = runtime.getHarnessAdapter(frontendDef.internalId)
        const detection = await adapter.detect()
        if (!detection.available) {
          throw new Error(
            `Harness "${frontendDef.internalId}" is not available: ${detection.error ?? 'not found'}`
          )
        }

        const bundle = await adapter.loadTargetBundle(
          materialized.materialization.outputPath,
          materialized.targetName
        )
        const isResume = !!req.continuation?.key
        const runOptions = {
          interactive: req.interactionMode === 'interactive',
          model: modelResolution.info.model,
          ...(req.modelReasoningEffort !== undefined
            ? { modelReasoningEffort: req.modelReasoningEffort }
            : {}),
          projectPath: req.cwd,
          cwd: req.cwd,
          yolo: req.yolo,
          ...(isResume && req.continuation?.key ? { continuationKey: req.continuation.key } : {}),
        }

        if (adapter.prepareWorkspace) {
          warnings.push(...(await adapter.prepareWorkspace(req.cwd)))
        }

        const args = adapter.buildRunArgs(bundle, runOptions)
        const adapterEnv = adapter.getRunEnv(bundle, runOptions)
        const commandPath = detection.path ?? frontendDef.internalId
        const argv = [commandPath, ...args]
        const env: Record<string, string> = {
          ...adapterEnv,
          ASP_HOME: req.aspHome,
        }
        const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)
        const continuation: HarnessContinuationRef | undefined = req.continuation
          ? { provider: frontendDef.provider, key: req.continuation.key }
          : undefined
        const invocationSpec: ProcessInvocationSpec = {
          provider: frontendDef.provider,
          frontend: req.frontend,
          argv,
          cwd: req.cwd,
          env,
          interactionMode: req.interactionMode,
          ioMode: req.ioMode,
          ...(continuation ? { continuation } : {}),
          displayCommand,
          ...(req.frontend === 'codex-cli' && req.interactionMode === 'headless'
            ? { codexAppServer: buildCodexAppServerLaunchDescriptor(runOptions) }
            : {}),
          prompts: { system: null, priming: null },
        }

        return { spec: invocationSpec, ...(warnings.length > 0 ? { warnings } : {}) }
      })
    },

    async buildHarnessBrokerInvocation(
      req: BuildHarnessBrokerInvocationRequest
    ): Promise<BuildHarnessBrokerInvocationResponse> {
      validateBrokerInvocationRequest(req)
      const prepared = await preparePlacementCliRuntime(
        req,
        clientAspHome,
        clientRegistryPath,
        requireAgentSpacesRuntime(clientRuntime)
      )
      return toHarnessBrokerStartRequest(prepared, req)
    },
  }
  return client as unknown as CompilerAgentSpacesClient
}
