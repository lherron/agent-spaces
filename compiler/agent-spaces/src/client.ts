import { isAbsolute } from 'node:path'

import {
  HARNESS_PROVIDERS,
  buildCodexAppServerLaunchDescriptor,
  getHarnessFrontendsForProvider,
  normalizeAgentSdkModel,
} from 'spaces-config'
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
import { preparePlacementCliRuntime, toProcessInvocationSpec } from './prepare-cli-runtime.js'
import type {
  BuildHarnessBrokerInvocationRequest,
  BuildHarnessBrokerInvocationResponse,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  InvocationSpecBuilder,
  ProcessInvocationSpec,
  ResolveRequest,
  ResolveResponse,
  RuntimeCompiler,
  SpaceResolver,
} from './types.js'

type CompilerAgentSpacesClient = RuntimeCompiler & SpaceResolver & InvocationSpecBuilder

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

  return {
    async compileRuntimePlan(req, options) {
      return compileRuntimePlan(req, {
        clientAspHome,
        clientRegistryPath,
        clientRuntime,
        ...(options?.compileContext !== undefined
          ? { compileContext: options.compileContext }
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
}
