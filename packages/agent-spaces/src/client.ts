import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'

import { basename, isAbsolute, join, resolve } from 'node:path'

import {
  AGENT_SDK_MODELS,
  CLAUDE_CODE_MODELS,
  DEFAULT_AGENT_SDK_MODEL,
  DEFAULT_CLAUDE_CODE_MODEL,
  HARNESS_PROVIDERS,
  type HarnessId,
  type LintWarning,
  type LockFile,
  PathResolver,
  type SpaceRefString,
  asSha256Integrity,
  asSpaceId,
  computeClosure,
  discoverSkills,
  ensureDir,
  generateLockFileForTarget,
  getAspHome,
  getHarnessCatalogEntryByFrontend,
  getHarnessFrontendsForProvider,
  getRegistryPath,
  lintSpaces,
  normalizeAgentSdkModel,
  readHooksWithPrecedence,
  resolveTarget,
} from 'spaces-config'

import { type RuntimePlacement, resolvePlacementContext } from 'spaces-config'

import {
  type UnifiedSession,
  type UnifiedSessionEvent,
  createSession,
  detectAgentLocalComponents,
  harnessRegistry,
  materializeFromRefs,
  materializeTarget,
  planPlacementRuntime,
  prepareCodexRuntimeHome,
} from 'spaces-execution'

import { PiSession, loadPiSdkBundle } from 'spaces-harness-pi-sdk/pi-session'

import { buildCorrelationEnvVars } from './placement-api.js'

import {
  type InFlightRunContext,
  completeInFlightFailure,
  completeInFlightSuccess,
  createInFlightRunMap,
  enqueueInFlightPrompt,
  rejectInFlight,
  resolveInFlight,
} from './run-tracker.js'

import { materializeSystemPrompt } from 'spaces-runtime'
import {
  applyEnvOverlay,
  piSessionPath,
  resolveHostSessionId,
  resolveRunId,
  withAspHome,
} from './runtime-env.js'

import {
  type EventPayload,
  buildAutoPermissionHandler,
  createEventEmitter,
  mapUnifiedEvents,
  runSession,
} from './session-events.js'

import type {
  AgentSpacesClient,
  AgentSpacesError,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  InterruptInFlightTurnRequest,
  ProcessInvocationSpec,
  ProviderDomain,
  QueueInFlightInputRequest,
  QueueInFlightInputResponse,
  ResolveRequest,
  ResolveResponse,
  RunResult,
  RunTurnInFlightRequest,
  RunTurnNonInteractiveRequest,
  RunTurnNonInteractiveResponse,
  SpaceSpec,
} from './types.js'

// ---------------------------------------------------------------------------
// Frontend definitions (provider-typed harness registry, spec §5.1)
// ---------------------------------------------------------------------------

const AGENT_SDK_FRONTEND: HarnessFrontend = 'agent-sdk'
const PI_SDK_FRONTEND: HarnessFrontend = 'pi-sdk'
const CLAUDE_CODE_FRONTEND: HarnessFrontend = 'claude-code'
const CODEX_CLI_FRONTEND: HarnessFrontend = 'codex-cli'

const PI_SDK_MODELS = [
  'openai-codex/gpt-5.4',
  'openai-codex/gpt-5.3-codex',
  'openai-codex/gpt-5.3',
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
  'api/gpt-5.4',
  'api/gpt-5.3-codex',
  'api/gpt-5.3',
  'api/gpt-5.2-codex',
  'api/gpt-5.2',
]

const CODEX_CLI_MODELS = [
  'gpt-5.4',
  'gpt-5.3-codex',
  'gpt-5.3',
  'gpt-5.2-codex',
  'gpt-5.1-codex-mini',
  'gpt-5.1-codex-max',
  'gpt-5.2',
  'gpt-5.1',
  'gpt-5.1-codex',
  'gpt-5-codex',
  'gpt-5-codex-mini',
  'gpt-5',
]

const DEFAULT_PI_SDK_MODEL = 'openai-codex/gpt-5.4'
const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.4'

interface FrontendDef {
  provider: ProviderDomain
  internalId: HarnessId
  frontend: HarnessFrontend
  models: string[]
  defaultModel: string
}

function createFrontendDef(
  frontend: HarnessFrontend,
  models: string[],
  defaultModel: string
): FrontendDef {
  const catalogEntry = getHarnessCatalogEntryByFrontend(frontend)
  if (!catalogEntry) {
    throw new Error(`Unknown harness frontend "${frontend}"`)
  }
  return {
    provider: catalogEntry.provider,
    internalId: catalogEntry.id,
    frontend,
    models,
    defaultModel,
  }
}

const FRONTEND_DEFS = new Map<HarnessFrontend, FrontendDef>([
  [
    AGENT_SDK_FRONTEND,
    createFrontendDef(AGENT_SDK_FRONTEND, AGENT_SDK_MODELS, DEFAULT_AGENT_SDK_MODEL),
  ],
  [PI_SDK_FRONTEND, createFrontendDef(PI_SDK_FRONTEND, PI_SDK_MODELS, DEFAULT_PI_SDK_MODEL)],
  [
    CLAUDE_CODE_FRONTEND,
    createFrontendDef(CLAUDE_CODE_FRONTEND, CLAUDE_CODE_MODELS, DEFAULT_CLAUDE_CODE_MODEL),
  ],
  [
    CODEX_CLI_FRONTEND,
    createFrontendDef(CODEX_CLI_FRONTEND, CODEX_CLI_MODELS, DEFAULT_CODEX_CLI_MODEL),
  ],
])

// ---------------------------------------------------------------------------
// Coded errors (carry structured error codes for spec compliance)
// ---------------------------------------------------------------------------

class CodedError extends Error {
  readonly code: NonNullable<AgentSpacesError['code']>
  constructor(message: string, code: NonNullable<AgentSpacesError['code']>) {
    super(message)
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ValidatedSpec {
  kind: 'spaces' | 'target'
  spaces?: string[]
  targetName?: string
  targetDir?: string
}

interface MaterializedSpec {
  targetName: string
  materialization: {
    outputPath: string
    pluginDirs: string[]
    mcpConfigPath?: string | undefined
  }
  skills: string[]
}

interface ModelInfo {
  effectiveModel: string
  provider: string
  model: string
}

// ---------------------------------------------------------------------------
// Helpers: spec validation
// ---------------------------------------------------------------------------

function validateSpec(spec: SpaceSpec): ValidatedSpec {
  const hasSpaces = 'spaces' in spec
  const hasTarget = 'target' in spec

  if (hasSpaces === hasTarget) {
    throw new Error('SpaceSpec must include exactly one of "spaces" or "target"')
  }

  if (hasTarget) {
    const target = spec.target
    if (!target?.targetName) {
      throw new Error('SpaceSpec target must include targetName')
    }
    if (!target?.targetDir) {
      throw new Error('SpaceSpec target must include targetDir')
    }
    if (!isAbsolute(target.targetDir)) {
      throw new Error('SpaceSpec targetDir must be an absolute path')
    }
    return {
      kind: 'target',
      targetName: target.targetName,
      targetDir: target.targetDir,
    }
  }

  if (!spec.spaces || spec.spaces.length === 0) {
    throw new Error('SpaceSpec spaces must include at least one space reference')
  }

  return {
    kind: 'spaces',
    spaces: spec.spaces,
  }
}

function computeSpacesTargetName(spaces: string[]): string {
  const hash = createHash('sha256')
  hash.update(JSON.stringify(spaces))
  return `spaces-${hash.digest('hex').slice(0, 12)}`
}

// ---------------------------------------------------------------------------
// Helpers: frontend resolution + model validation
// ---------------------------------------------------------------------------

function resolveFrontend(frontend: HarnessFrontend): FrontendDef & { frontend: HarnessFrontend } {
  const def = FRONTEND_DEFS.get(frontend)
  if (!def) {
    throw new CodedError(`Unsupported frontend: ${frontend}`, 'unsupported_frontend')
  }
  return { ...def, frontend }
}

function validateProviderMatch(
  frontendDef: FrontendDef & { frontend: HarnessFrontend },
  continuation: HarnessContinuationRef | undefined
): void {
  if (continuation && continuation.provider !== frontendDef.provider) {
    throw new CodedError(
      `Provider mismatch: frontend "${frontendDef.frontend}" is provider "${frontendDef.provider}" but continuation is provider "${continuation.provider}"`,
      'provider_mismatch'
    )
  }
}

function parseModelId(modelId: string): ModelInfo | null {
  const separatorIndex = modelId.indexOf('/')
  if (separatorIndex === -1) {
    return { effectiveModel: modelId, provider: 'codex', model: modelId }
  }
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) {
    return null
  }
  const provider = modelId.slice(0, separatorIndex)
  const model = modelId.slice(separatorIndex + 1)
  if (!provider || !model) {
    return null
  }
  return { effectiveModel: modelId, provider, model }
}

function resolveModel(
  frontendDef: { models: string[]; defaultModel: string },
  requested: string | undefined
): { ok: true; info: ModelInfo } | { ok: false; modelId: string } {
  const modelId = requested ?? frontendDef.defaultModel
  if (!frontendDef.models.includes(modelId)) {
    return { ok: false, modelId }
  }
  const info = parseModelId(modelId)
  if (!info) {
    return { ok: false, modelId }
  }
  return { ok: true, info }
}

// ---------------------------------------------------------------------------
// Helpers: spec resolution + materialization
// ---------------------------------------------------------------------------

async function resolveSpecToLock(
  spec: ValidatedSpec,
  aspHome: string,
  registryPathOverride?: string | undefined
): Promise<{ targetName: string; lock: LockFile; registryPath: string }> {
  if (spec.kind === 'target') {
    const result = await resolveTarget(spec.targetName as string, {
      projectPath: spec.targetDir as string,
      aspHome,
      ...(registryPathOverride ? { registryPath: registryPathOverride } : {}),
    })
    const registryPath = getRegistryPath({
      projectPath: spec.targetDir as string,
      aspHome,
      ...(registryPathOverride ? { registryPath: registryPathOverride } : {}),
    })
    return { targetName: spec.targetName as string, lock: result.lock, registryPath }
  }

  const refs = spec.spaces as string[]
  const targetName = computeSpacesTargetName(refs)
  const paths = new PathResolver({ aspHome })
  const registryPath = registryPathOverride ?? paths.repo
  const closure = await computeClosure(refs as SpaceRefString[], {
    cwd: registryPath,
  })
  const lock = await generateLockFileForTarget(targetName, refs as SpaceRefString[], closure, {
    cwd: registryPath,
    registry: { type: 'git', url: registryPath },
  })

  return { targetName, lock, registryPath }
}

async function materializeSpec(
  spec: ValidatedSpec,
  aspHome: string,
  harnessId: HarnessId,
  options?: {
    registryPathOverride?: string | undefined
    agentRoot?: string | undefined
    projectRoot?: string | undefined
    agentLocalComponents?: import('spaces-config').AgentLocalComponents | undefined
  }
): Promise<MaterializedSpec> {
  const registryPathOverride = options?.registryPathOverride
  if (spec.kind === 'target') {
    const { targetName, lock, registryPath } = await resolveSpecToLock(
      spec,
      aspHome,
      registryPathOverride
    )
    const materialization = await materializeTarget(targetName, lock, {
      projectPath: spec.targetDir as string,
      aspHome,
      registryPath,
      harness: harnessId,
    })
    const skillMetadata = await discoverSkills(materialization.pluginDirs)
    return {
      targetName,
      materialization: {
        outputPath: materialization.outputPath,
        pluginDirs: materialization.pluginDirs,
        mcpConfigPath: materialization.mcpConfigPath,
      },
      skills: skillMetadata.map((skill) => skill.name),
    }
  }

  const refs = spec.spaces as string[]
  if (refs.length === 0) {
    // No spaces — create minimal empty materialization
    const targetName = 'placement-empty'
    const paths = new PathResolver({ aspHome })
    const materialized = await materializeFromRefs({
      targetName,
      refs: [],
      registryPath: registryPathOverride ?? paths.repo,
      aspHome,
      lockPath: paths.globalLock,
      harness: harnessId,
    })
    return {
      targetName,
      materialization: {
        outputPath: materialized.materialization.outputPath,
        pluginDirs: materialized.materialization.pluginDirs,
        mcpConfigPath: materialized.materialization.mcpConfigPath,
      },
      skills: materialized.skills.map((skill) => skill.name),
    }
  }

  const targetName = computeSpacesTargetName(refs)
  const paths = new PathResolver({ aspHome })
  const registryPath = registryPathOverride ?? paths.repo
  const materialized = await materializeFromRefs({
    targetName,
    refs: refs as SpaceRefString[],
    registryPath,
    aspHome,
    lockPath: paths.globalLock,
    harness: harnessId,
    ...(options?.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options?.projectRoot ? { projectRoot: options.projectRoot } : {}),
    ...(options?.agentLocalComponents
      ? { agentLocalComponents: options.agentLocalComponents }
      : {}),
  })

  return {
    targetName,
    materialization: {
      outputPath: materialized.materialization.outputPath,
      pluginDirs: materialized.materialization.pluginDirs,
      mcpConfigPath: materialized.materialization.mcpConfigPath,
    },
    skills: materialized.skills.map((skill) => skill.name),
  }
}

// ---------------------------------------------------------------------------
// Helpers: lint, hooks, tools
// ---------------------------------------------------------------------------

async function collectLintWarnings(
  spec: ValidatedSpec,
  aspHome: string,
  registryPathOverride?: string | undefined
): Promise<LintWarning[]> {
  const { targetName, lock, registryPath } = await resolveSpecToLock(
    spec,
    aspHome,
    registryPathOverride
  )
  const target = lock.targets[targetName]
  if (!target) {
    const available = Object.keys(lock.targets)
    const availableStr =
      available.length > 0 ? `Available: ${available.join(', ')}` : 'No targets in lock'
    throw new Error(`Target "${targetName}" not found in lock file. ${availableStr}`)
  }

  const paths = new PathResolver({ aspHome })
  const lintData = target.loadOrder.map((key) => {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space entry "${key}" not found in lock for target "${targetName}"`)
    }
    const isDev = entry.commit === 'dev'
    const pluginPath = isDev
      ? join(registryPath, entry.path)
      : paths.snapshot(asSha256Integrity(entry.integrity))

    return {
      key,
      manifest: {
        schema: 1 as const,
        id: asSpaceId(entry.id),
        plugin: {
          name: entry.plugin.name,
          version: entry.plugin.version,
        },
      },
      pluginPath,
    }
  })

  return lintSpaces({ spaces: lintData })
}

async function collectHooks(pluginDirs: string[]): Promise<string[]> {
  const hooks: string[] = []
  for (const dir of pluginDirs) {
    const hooksDir = join(dir, 'hooks')
    const result = await readHooksWithPrecedence(hooksDir)
    for (const hook of result.hooks) {
      hooks.push(hook.event)
    }
  }
  return hooks
}

async function collectTools(mcpConfigPath: string | undefined): Promise<string[]> {
  if (!mcpConfigPath) return []
  const raw = await readFile(mcpConfigPath, 'utf-8')
  const parsed = JSON.parse(raw) as { mcpServers?: Record<string, unknown> } | undefined
  if (!parsed?.mcpServers) return []
  return Object.keys(parsed.mcpServers)
}

// ---------------------------------------------------------------------------
// Helpers: error conversion
// ---------------------------------------------------------------------------

function toAgentSpacesError(error: unknown, code?: AgentSpacesError['code']): AgentSpacesError {
  const message = error instanceof Error ? error.message : String(error)
  const errorCode = code ?? (error instanceof CodedError ? error.code : undefined)
  const details: Record<string, unknown> = {}
  if (error instanceof Error && error.stack) {
    details['stack'] = error.stack
  }
  return {
    message,
    ...(errorCode ? { code: errorCode } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}

// ---------------------------------------------------------------------------
// Helpers: shell quoting (for displayCommand in buildProcessInvocationSpec)
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatDisplayCommand(
  commandPath: string,
  args: string[],
  env: Record<string, string>
): string {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')
  const command = [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
  return envPrefix ? `${envPrefix} ${command}` : command
}

// ---------------------------------------------------------------------------
// Client implementation
// ---------------------------------------------------------------------------

export interface AgentSpacesClientOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
}

export function createAgentSpacesClient(options?: AgentSpacesClientOptions): AgentSpacesClient {
  const clientAspHome = options?.aspHome
  const _clientRegistryPath = options?.registryPath
  const inFlightRuns = createInFlightRunMap()

  return {
    async resolve(req: ResolveRequest): Promise<ResolveResponse> {
      return withAspHome(req.aspHome, async () => {
        try {
          const spec = validateSpec(req.spec)
          await resolveSpecToLock(spec, req.aspHome)
          return { ok: true }
        } catch (error) {
          return {
            ok: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
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
          registryPathOverride: req.registryPath,
        })
        const hooks = await collectHooks(materialized.materialization.pluginDirs)
        const tools = await collectTools(materialized.materialization.mcpConfigPath)
        const lintWarnings =
          req.runLint === true
            ? await collectLintWarnings(spec, req.aspHome, req.registryPath)
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
            { paramName: 'sessionId', paramValue: resolveHostSessionId(req, false) ?? null },
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
      // Placement-based path (v2)
      if (req.placement) {
        return buildPlacementInvocationSpec(req, clientAspHome)
      }

      return withAspHome(req.aspHome, async () => {
        const warnings: string[] = []
        const spec = validateSpec(req.spec)

        // Validate cwd is absolute (spec §6.3)
        if (!isAbsolute(req.cwd)) {
          throw new Error('cwd must be an absolute path')
        }

        const frontendDef = resolveFrontend(req.frontend)

        // Validate provider matches frontend
        if (req.provider !== frontendDef.provider) {
          throw new CodedError(
            `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`,
            'provider_mismatch'
          )
        }

        // Validate provider match with continuation if provided
        validateProviderMatch(frontendDef, req.continuation)

        // Validate model
        const modelResolution = resolveModel(frontendDef, req.model)
        if (!modelResolution.ok) {
          throw new Error(
            `Model not supported for frontend ${req.frontend}: ${modelResolution.modelId}`
          )
        }

        // Materialize the spec
        const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)

        // Get adapter from registry and detect binary
        const adapter = harnessRegistry.getOrThrow(frontendDef.internalId)
        const detection = await adapter.detect()
        if (!detection.available) {
          throw new Error(
            `Harness "${frontendDef.internalId}" is not available: ${detection.error ?? 'not found'}`
          )
        }

        // Load the composed target bundle
        const bundle = await adapter.loadTargetBundle(
          materialized.materialization.outputPath,
          materialized.targetName
        )

        // Build run options for the adapter
        const isResume = !!req.continuation?.key
        const runOptions = {
          interactive: req.interactionMode === 'interactive',
          model: modelResolution.info.model,
          projectPath: req.cwd,
          cwd: req.cwd,
          yolo: req.yolo,
          ...(isResume && req.continuation?.key ? { continuationKey: req.continuation.key } : {}),
        }

        // Build argv and env using the adapter
        const args = adapter.buildRunArgs(bundle, runOptions)
        const adapterEnv = adapter.getRunEnv(bundle, runOptions)
        const commandPath = detection.path ?? frontendDef.internalId
        const argv = [commandPath, ...args]

        // Merge env: adapter env + request env delta
        const env: Record<string, string> = {
          ...adapterEnv,
          ...(req.env ?? {}),
          ASP_HOME: req.aspHome,
        }

        // Build display command
        const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

        // Build continuation ref
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
        }

        return { spec: invocationSpec, ...(warnings.length > 0 ? { warnings } : {}) }
      })
    },

    async runTurnInFlight(req: RunTurnInFlightRequest): Promise<RunTurnNonInteractiveResponse> {
      return withAspHome(req.aspHome, async () => {
        const frontendDef = resolveFrontend(req.frontend)
        const hostSessionId = resolveHostSessionId(req)
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { hostSessionId: hostSessionId as string, runId: req.runId },
          req.continuation
        )

        if (frontendDef.frontend !== AGENT_SDK_FRONTEND) {
          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(
              new CodedError(
                `In-flight input is only supported for frontend "${AGENT_SDK_FRONTEND}"`,
                'unsupported_frontend'
              )
            ),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
        }

        if (inFlightRuns.has(hostSessionId as string)) {
          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(
              new Error(`In-flight run already active for hostSessionId ${hostSessionId as string}`)
            ),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
        }

        let spec: ValidatedSpec
        let modelResolution: ReturnType<typeof resolveModel>
        const continuationKey = req.continuation?.key

        try {
          spec = validateSpec(req.spec)
          if (!isAbsolute(req.cwd)) {
            throw new Error('cwd must be an absolute path')
          }
          validateProviderMatch(frontendDef, req.continuation)
          modelResolution = resolveModel(frontendDef, req.model)
        } catch (error) {
          const result: RunResult = { success: false, error: toAgentSpacesError(error) }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
        }

        if (continuationKey) {
          eventEmitter.setContinuation({
            provider: frontendDef.provider,
            key: continuationKey,
          })
        }

        await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
        await eventEmitter.emit({
          type: 'message',
          role: 'user',
          content: req.prompt,
        } as EventPayload)

        if (!modelResolution.ok) {
          const error = toAgentSpacesError(
            new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            ),
            'model_not_supported'
          )
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.modelId,
            result,
          }
        }

        const permissionHandler = buildAutoPermissionHandler()
        let session: UnifiedSession | undefined
        let context: InFlightRunContext | undefined

        try {
          const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)
          const restoreEnv = applyEnvOverlay({ ...(req.env ?? {}) })

          try {
            const plugins = materialized.materialization.pluginDirs.map((dir) => ({
              type: 'local' as const,
              path: dir,
            }))

            session = createSession({
              kind: 'agent-sdk',
              sessionId: continuationKey ?? (hostSessionId as string),
              cwd: req.cwd,
              model: normalizeAgentSdkModel(modelResolution.info.model),
              plugins,
              permissionHandler,
              ...(continuationKey ? { continuationKey } : {}),
            })

            const completionPromise = new Promise<RunTurnNonInteractiveResponse>(
              (resolve, reject) => {
                const activeSession = session
                if (!activeSession) {
                  throw new Error('Session creation failed unexpectedly')
                }
                const started = activeSession.start()
                const assistantState: {
                  assistantBuffer: string
                  lastAssistantText?: string | undefined
                } = { assistantBuffer: '' }

                context = {
                  hostSessionId: hostSessionId as string,
                  runId: req.runId,
                  provider: frontendDef.provider,
                  frontend: req.frontend,
                  model: modelResolution.info.effectiveModel,
                  session: activeSession,
                  eventEmitter,
                  assistantState,
                  allowSessionIdUpdate: true,
                  continuationKey,
                  outstandingTurns: 0,
                  started,
                  completion: { done: false, resolve, reject },
                  sendChain: Promise.resolve(),
                }

                inFlightRuns.set(hostSessionId as string, context)

                activeSession.onEvent((event: UnifiedSessionEvent) => {
                  if (!context || context.completion.done) return

                  const mapped = mapUnifiedEvents(
                    event,
                    (mappedEvent) => {
                      void context?.eventEmitter.emit(mappedEvent)
                    },
                    (key) => {
                      if (!context) return
                      context.continuationKey = key
                      context.eventEmitter.setContinuation({
                        provider: frontendDef.provider,
                        key,
                      })
                    },
                    context.assistantState,
                    { allowSessionIdUpdate: context.allowSessionIdUpdate }
                  )

                  if (!mapped.turnEnded) return

                  context.outstandingTurns = Math.max(0, context.outstandingTurns - 1)
                  if (context.outstandingTurns !== 0) return

                  const activeContext = context
                  void completeInFlightSuccess(activeContext)
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((error) => rejectInFlight(activeContext, error))
                })

                void started.catch((error) => {
                  if (!context || context.completion.done) return
                  const activeContext = context
                  void completeInFlightFailure(activeContext, error, 'resolve_failed')
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((failureError) => rejectInFlight(activeContext, failureError))
                })

                void enqueueInFlightPrompt(context, req.prompt, req.attachments).catch((error) => {
                  if (!context || context.completion.done) return
                  const activeContext = context
                  activeContext.outstandingTurns = Math.max(0, activeContext.outstandingTurns - 1)
                  void completeInFlightFailure(activeContext, error, 'resolve_failed')
                    .then((response) => resolveInFlight(activeContext, response))
                    .catch((failureError) => rejectInFlight(activeContext, failureError))
                })
              }
            )

            return await completionPromise
          } finally {
            inFlightRuns.delete(hostSessionId as string)
            if (session) {
              try {
                await session.stop('complete')
              } catch {
                // Ignore cleanup failures.
              }
            }
            restoreEnv()
            await eventEmitter.idle()
          }
        } catch (error) {
          if (context && !context.completion.done) {
            const response = await completeInFlightFailure(context, error, 'resolve_failed')
            resolveInFlight(context, response)
            return response
          }

          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            result,
          }
        }
      })
    },

    async queueInFlightInput(req: QueueInFlightInputRequest): Promise<QueueInFlightInputResponse> {
      const hostSessionId = resolveHostSessionId(req)
      const context = inFlightRuns.get(hostSessionId as string)
      if (!context) {
        throw new Error(`No active in-flight run for hostSessionId ${hostSessionId as string}`)
      }
      if (context.runId !== req.runId) {
        throw new Error(
          `Active in-flight run mismatch for hostSessionId ${hostSessionId as string}: expected ${context.runId}, got ${req.runId}`
        )
      }
      if (context.completion.done) {
        throw new Error(`In-flight run ${req.runId} is already completed`)
      }

      await context.eventEmitter.emit({
        type: 'message',
        role: 'user',
        content: req.prompt,
      } as EventPayload)

      await enqueueInFlightPrompt(context, req.prompt, req.attachments)
      return { accepted: true, pendingTurns: context.outstandingTurns }
    },

    async interruptInFlightTurn(req: InterruptInFlightTurnRequest): Promise<void> {
      const hostSessionId = resolveHostSessionId(req)
      const context = inFlightRuns.get(hostSessionId as string)
      if (!context) {
        throw new Error(`No active in-flight run for hostSessionId ${hostSessionId as string}`)
      }
      if (req.runId && context.runId !== req.runId) {
        throw new Error(
          `Active in-flight run mismatch for hostSessionId ${hostSessionId as string}: expected ${context.runId}, got ${req.runId}`
        )
      }
      if (context.completion.done) {
        return
      }

      const interruptable = context.session as { interrupt?: (reason?: string) => Promise<void> }
      if (typeof interruptable.interrupt === 'function') {
        await interruptable.interrupt(req.reason)
        return
      }

      // Fallback: hard-stop when an interrupt primitive is unavailable.
      await context.session.stop(req.reason ?? 'interrupt')
    },

    async runTurnNonInteractive(
      req: RunTurnNonInteractiveRequest
    ): Promise<RunTurnNonInteractiveResponse> {
      // Placement-based path (v2)
      if (req.placement) {
        return runPlacementTurnNonInteractive(req, clientAspHome)
      }

      return withAspHome(req.aspHome, async () => {
        const frontendDef = resolveFrontend(req.frontend)
        const hostSessionId = resolveHostSessionId(req)
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { hostSessionId: hostSessionId as string, runId: req.runId },
          req.continuation
        )

        let spec: ValidatedSpec
        let modelResolution: ReturnType<typeof resolveModel>
        let continuationKey = req.continuation?.key

        try {
          spec = validateSpec(req.spec)

          // Validate cwd is absolute (spec §6.3)
          if (!isAbsolute(req.cwd)) {
            throw new Error('cwd must be an absolute path')
          }

          // Validate provider match with continuation
          validateProviderMatch(frontendDef, req.continuation)

          modelResolution = resolveModel(frontendDef, req.model)
        } catch (error) {
          const result: RunResult = { success: false, error: toAgentSpacesError(error) }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: req.model,
            result,
          }
        }

        // Determine session/continuation context (no session record persistence)
        const isResume = continuationKey !== undefined
        if (frontendDef.frontend === PI_SDK_FRONTEND && !continuationKey) {
          // For pi-sdk first run, create deterministic session path as continuation key
          continuationKey = piSessionPath(req.aspHome, hostSessionId as string)
        }

        // Update continuation on emitter
        if (continuationKey) {
          eventEmitter.setContinuation({
            provider: frontendDef.provider,
            key: continuationKey,
          })
        }

        await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
        await eventEmitter.emit({
          type: 'message',
          role: 'user',
          content: req.prompt,
        } as EventPayload)

        if (!modelResolution.ok) {
          const error = toAgentSpacesError(
            new Error(
              `Model not supported for frontend ${frontendDef.frontend}: ${modelResolution.modelId}`
            ),
            'model_not_supported'
          )
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.modelId,
            result,
          }
        }

        // For pi-sdk resume: validate session path exists
        if (frontendDef.frontend === PI_SDK_FRONTEND && isResume && continuationKey) {
          if (!existsSync(continuationKey)) {
            const error = toAgentSpacesError(
              new Error(`Continuation not found: ${continuationKey}`),
              'continuation_not_found'
            )
            const result: RunResult = { success: false, error }
            await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
            await eventEmitter.emit({ type: 'complete', result } as EventPayload)
            return {
              continuation: { provider: frontendDef.provider, key: continuationKey },
              provider: frontendDef.provider,
              frontend: req.frontend,
              model: modelResolution.info.effectiveModel,
              result,
            }
          }
        }

        // For pi-sdk first run: ensure session directory exists
        if (frontendDef.frontend === PI_SDK_FRONTEND && !isResume && continuationKey) {
          await ensureDir(continuationKey)
        }

        const permissionHandler = buildAutoPermissionHandler()

        let session: UnifiedSession | undefined
        let turnEnded = false
        let finalOutput: string | undefined
        const assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined } =
          {
            assistantBuffer: '',
          }

        try {
          const materialized = await materializeSpec(spec, req.aspHome, frontendDef.internalId)

          const harnessEnv: Record<string, string> = { ...(req.env ?? {}) }
          if (frontendDef.frontend === PI_SDK_FRONTEND) {
            harnessEnv['PI_CODING_AGENT_DIR'] = materialized.materialization.outputPath
          }

          const restoreEnv = applyEnvOverlay(harnessEnv)
          try {
            if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
              const plugins = materialized.materialization.pluginDirs.map((dir) => ({
                type: 'local' as const,
                path: dir,
              }))
              session = createSession({
                kind: 'agent-sdk',
                sessionId: continuationKey ?? (hostSessionId as string),
                cwd: req.cwd,
                model: normalizeAgentSdkModel(modelResolution.info.model),
                plugins,
                permissionHandler,
                ...(isResume && continuationKey ? { continuationKey } : {}),
              })
            } else {
              // pi-sdk
              const bundle = await loadPiSdkBundle(materialized.materialization.outputPath, {
                cwd: req.cwd,
                yolo: true,
                noExtensions: false,
                noSkills: false,
                agentDir: materialized.materialization.outputPath,
              })
              const piSession = new PiSession({
                ownerId: hostSessionId as string,
                cwd: req.cwd,
                provider: modelResolution.info.provider,
                model: modelResolution.info.model,
                sessionId: hostSessionId as string,
                extensions: bundle.extensions,
                skills: bundle.skills,
                contextFiles: bundle.contextFiles,
                agentDir: materialized.materialization.outputPath,
                ...(continuationKey ? { sessionPath: continuationKey } : {}),
              })
              piSession.setPermissionHandler(permissionHandler)
              session = piSession
            }

            const turnPromise = new Promise<void>((resolve, reject) => {
              if (!session) return
              session.onEvent((event: UnifiedSessionEvent) => {
                const result = mapUnifiedEvents(
                  event,
                  (mapped) => {
                    void eventEmitter.emit(mapped)
                  },
                  (key) => {
                    // Continuation key observed from SDK events
                    continuationKey = key
                    eventEmitter.setContinuation({
                      provider: frontendDef.provider,
                      key,
                    })
                  },
                  assistantState,
                  { allowSessionIdUpdate: frontendDef.frontend !== PI_SDK_FRONTEND }
                )

                if (result.turnEnded && !turnEnded) {
                  turnEnded = true
                  void eventEmitter.idle().then(resolve, reject)
                }
              })
            })

            await runSession(session, req.prompt, req.attachments, req.runId)
            await turnPromise
            await session.stop('complete')
            await eventEmitter.idle()
            finalOutput = assistantState.lastAssistantText
          } finally {
            restoreEnv()
          }

          const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
          await eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)

          // Build final continuation ref
          const finalContinuation: HarnessContinuationRef | undefined = continuationKey
            ? { provider: frontendDef.provider, key: continuationKey }
            : undefined

          return {
            ...(finalContinuation ? { continuation: finalContinuation } : {}),
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.info.effectiveModel,
            result,
          }
        } catch (error) {
          if (session) {
            try {
              await session.stop('error')
            } catch {
              // Ignore cleanup failures.
            }
          }

          const result: RunResult = {
            success: false,
            error: toAgentSpacesError(error, 'resolve_failed'),
          }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)

          const finalContinuation: HarnessContinuationRef | undefined = continuationKey
            ? { provider: frontendDef.provider, key: continuationKey }
            : undefined

          return {
            ...(finalContinuation ? { continuation: finalContinuation } : {}),
            provider: frontendDef.provider,
            frontend: req.frontend,
            model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            result,
          }
        }
      })
    },
  }
}

/**
 * Handle placement-based buildProcessInvocationSpec request.
 * Resolves placement, materializes spaces, and builds full CLI invocation
 * through the harness adapter (matching the legacy path).
 */
async function buildPlacementInvocationSpec(
  req: BuildProcessInvocationSpecRequest,
  defaultAspHome?: string
): Promise<BuildProcessInvocationSpecResponse> {
  const placement = req.placement as RuntimePlacement
  const warnings: string[] = []

  const frontendDef = resolveFrontend(req.frontend)

  // Validate provider matches frontend
  if (req.provider !== frontendDef.provider) {
    throw new CodedError(
      `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`,
      'provider_mismatch'
    )
  }

  // Validate provider match with continuation if provided
  validateProviderMatch(frontendDef, req.continuation)

  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const { spec } = placementContext.materialization

  // Resolve placement to get audit metadata and materialization inputs
  const resolvedBundle = placementContext.resolvedBundle

  // Resolve effective cwd from placement
  const cwd = resolvedBundle.cwd

  const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
  const runtimePlan = await planPlacementRuntime({
    placement,
    placementContext,
    frontend: req.frontend,
    aspHome,
    model: req.model,
    prompt: req.prompt,
    yolo: req.yolo,
    interactive: req.interactionMode === 'interactive',
    continuationKey: req.continuation?.key,
  })
  if (!runtimePlan.model.ok) {
    throw new Error(
      `Model not supported for frontend ${req.frontend}: ${runtimePlan.model.modelId}`
    )
  }

  // Get adapter from registry and detect binary
  const adapter = harnessRegistry.getOrThrow(runtimePlan.harnessId)
  const detection = await adapter.detect()
  if (!detection.available) {
    throw new Error(
      `Harness "${runtimePlan.harnessId}" is not available: ${detection.error ?? 'not found'}`
    )
  }

  // Detect agent-local skills/ and commands/ for materialization
  const agentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)

  // Unified materialization: use the shared placement context, then materialize the resolved spec.
  const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
    agentRoot: placement.agentRoot,
    projectRoot: placement.projectRoot,
    agentLocalComponents,
  })
  const systemPrompt = await materializeSystemPrompt(
    materialized.materialization.outputPath,
    placement
  )

  const bundle = await adapter.loadTargetBundle(
    materialized.materialization.outputPath,
    materialized.targetName
  )

  // Build run options for the adapter
  let runOptions: import('spaces-config').HarnessRunOptions = {
    ...runtimePlan.runOptions,
    model: runtimePlan.model.info.model,
    ...(runtimePlan.prompt !== undefined ? { prompt: runtimePlan.prompt } : {}),
    ...(runtimePlan.yolo !== undefined ? { yolo: runtimePlan.yolo } : {}),
    ...(systemPrompt
      ? {
          systemPrompt: systemPrompt.content,
          systemPromptMode: systemPrompt.mode,
        }
      : {}),
  }

  // For codex frontends, prepare the stable runtime home directory so that
  // hrc run uses the same CODEX_HOME as asp run (codex-homes/<project>_<target>).
  // prepareCodexRuntimeHome syncs managed files, injects system prompt into
  // AGENTS.md, ensures project trust, and symlinks auth — all the steps that
  // were previously duplicated inline here.
  if (frontendDef.frontend === CODEX_CLI_FRONTEND) {
    const codexHomeDir = await prepareCodexRuntimeHome(bundle, {
      ...runOptions,
      aspHome,
    })
    runOptions = { ...runOptions, codexHomeDir }
  }

  // Build argv and env using the adapter
  const args = adapter.buildRunArgs(bundle, runOptions)
  const adapterEnv = adapter.getRunEnv(bundle, runOptions)
  const commandPath = detection.path ?? runtimePlan.harnessId
  const argv = [commandPath, ...args]

  // Build correlation env vars
  const correlationEnv = buildCorrelationEnvVars(placement)

  // Derive ASP_PROJECT and AGENTCHAT_ID so tools like agentchat can discover
  // their project and agent context without a manual .env.local.
  const agentchatEnv: Record<string, string> = {
    AGENTCHAT_ID: basename(placement.agentRoot),
  }
  if (placement.projectRoot) {
    agentchatEnv['ASP_PROJECT'] = basename(resolve(placement.projectRoot))
  }

  // Merge env: adapter env + correlation + agentchat + request env delta + ASP_HOME
  const env: Record<string, string> = {
    ...adapterEnv,
    ...correlationEnv,
    ...agentchatEnv,
    ...(req.env ?? {}),
    ASP_HOME: aspHome,
  }

  // Build display command
  const displayCommand = formatDisplayCommand(commandPath, args, adapterEnv)

  // Build continuation ref
  const continuation: HarnessContinuationRef | undefined = req.continuation
    ? { provider: runtimePlan.provider, key: req.continuation.key }
    : undefined

  const invocationSpec: ProcessInvocationSpec = {
    provider: runtimePlan.provider,
    frontend: req.frontend,
    argv,
    cwd,
    env,
    interactionMode: req.interactionMode,
    ioMode: req.ioMode,
    ...(continuation ? { continuation } : {}),
    displayCommand,
    ...(systemPrompt ? { systemPromptFile: systemPrompt.path } : {}),
  }

  return {
    spec: invocationSpec,
    resolvedBundle,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/**
 * Handle placement-based runTurnNonInteractive request.
 * Resolves placement, materializes spaces, creates an SDK session, and runs the turn.
 */
async function runPlacementTurnNonInteractive(
  req: RunTurnNonInteractiveRequest,
  defaultAspHome?: string
): Promise<RunTurnNonInteractiveResponse> {
  const placement = req.placement as RuntimePlacement
  const frontendDef = resolveFrontend(req.frontend)
  const hostSessionId = resolveHostSessionId(req)
  const runId = resolveRunId(req)
  const eventEmitter = createEventEmitter(
    req.callbacks.onEvent,
    { hostSessionId: hostSessionId as string, runId: runId as string },
    req.continuation
  )

  let runtimePlan: Awaited<ReturnType<typeof planPlacementRuntime>>
  let continuationKey = req.continuation?.key
  let resolvedPrompt = req.prompt

  try {
    validateProviderMatch(frontendDef, req.continuation)

    const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
    const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
    runtimePlan = await planPlacementRuntime({
      placement,
      placementContext,
      frontend: req.frontend,
      aspHome,
      model: req.model,
      prompt: req.prompt,
      promptOverrideMode: 'truthy',
      yolo: req.yolo,
      continuationKey,
    })
    resolvedPrompt = runtimePlan.prompt ?? ''
  } catch (error) {
    const result: RunResult = { success: false, error: toAgentSpacesError(error) }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)
    return {
      provider: frontendDef.provider,
      frontend: req.frontend,
      model: req.model,
      result,
    }
  }

  if (continuationKey) {
    eventEmitter.setContinuation({
      provider: runtimePlan.provider,
      key: continuationKey,
    })
  }

  await eventEmitter.emit({ type: 'state', state: 'running' } as EventPayload)
  await eventEmitter.emit({
    type: 'message',
    role: 'user',
    content: resolvedPrompt,
  } as EventPayload)

  if (!runtimePlan.model.ok) {
    const error = toAgentSpacesError(
      new Error(
        `Model not supported for frontend ${frontendDef.frontend}: ${runtimePlan.model.modelId}`
      ),
      'model_not_supported'
    )
    const result: RunResult = { success: false, error }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)
    return {
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.modelId,
      result,
    }
  }

  const permissionHandler = buildAutoPermissionHandler()
  let session: UnifiedSession | undefined
  let turnEnded = false
  let finalOutput: string | undefined
  const assistantState: { assistantBuffer: string; lastAssistantText?: string | undefined } = {
    assistantBuffer: '',
  }

  try {
    // Resolve placement to get audit metadata, effective cwd, and materialization inputs.
    const placementContext = await resolvePlacementContext(placement)
    const resolvedBundle = placementContext.resolvedBundle
    const cwd = resolvedBundle.cwd

    // Build correlation env vars and apply env overlay
    const correlationEnv = buildCorrelationEnvVars(placement)
    const harnessEnv: Record<string, string> = { ...correlationEnv, ...(req.env ?? {}) }

    const aspHome = req.aspHome ?? defaultAspHome ?? getAspHome()
    harnessEnv['ASP_HOME'] = aspHome

    const restoreEnv = applyEnvOverlay(harnessEnv)

    try {
      // Unified materialization: use the shared placement context rather than
      // reconstructing client-local synthetic planning state.
      const { spec } = placementContext.materialization
      runtimePlan = await planPlacementRuntime({
        placement,
        placementContext,
        frontend: req.frontend,
        aspHome,
        model: req.model,
        prompt: req.prompt,
        promptOverrideMode: 'truthy',
        yolo: req.yolo,
        continuationKey,
      })
      if (!runtimePlan.model.ok) {
        throw new Error(
          `Model not supported for frontend ${frontendDef.frontend}: ${runtimePlan.model.modelId}`
        )
      }
      const resolvedYolo = runtimePlan.yolo ?? false
      const placementAgentLocalComponents = await detectAgentLocalComponents(placement.agentRoot)
      const materialized = await materializeSpec(spec, aspHome, runtimePlan.harnessId, {
        agentRoot: placement.agentRoot,
        projectRoot: placement.projectRoot,
        agentLocalComponents: placementAgentLocalComponents,
      })

      if (frontendDef.frontend === PI_SDK_FRONTEND) {
        harnessEnv['PI_CODING_AGENT_DIR'] = materialized.materialization.outputPath
      }

      if (frontendDef.frontend === AGENT_SDK_FRONTEND) {
        const plugins = (materialized.materialization.pluginDirs ?? []).map((dir) => ({
          type: 'local' as const,
          path: dir,
        }))

        // Materialize the instruction layer into a system prompt file and read it
        const systemPrompt = await materializeSystemPrompt(
          materialized.materialization.outputPath,
          placement
        )

        session = createSession({
          kind: 'agent-sdk',
          sessionId: continuationKey ?? (hostSessionId as string),
          cwd,
          model: normalizeAgentSdkModel(runtimePlan.model.info.model),
          plugins,
          permissionHandler,
          ...(continuationKey ? { continuationKey } : {}),
          ...(systemPrompt
            ? {
                systemPrompt: systemPrompt.content,
                systemPromptMode: systemPrompt.mode,
              }
            : {}),
        })
      } else {
        // pi-sdk — load bundle from materialized output
        const isResume = continuationKey !== undefined
        if (!isResume && !continuationKey && aspHome) {
          continuationKey = piSessionPath(aspHome, hostSessionId as string)
          await ensureDir(continuationKey)
          eventEmitter.setContinuation({
            provider: runtimePlan.provider,
            key: continuationKey,
          })
        }

        const piBundle = await loadPiSdkBundle(materialized.materialization.outputPath, {
          cwd,
          yolo: resolvedYolo,
          noExtensions: false,
          noSkills: false,
          agentDir: materialized.materialization.outputPath,
        })
        const piSession = new PiSession({
          ownerId: hostSessionId as string,
          cwd,
          provider: runtimePlan.model.info.provider,
          model: runtimePlan.model.info.model,
          sessionId: hostSessionId as string,
          extensions: piBundle.extensions,
          skills: piBundle.skills,
          contextFiles: piBundle.contextFiles,
          agentDir: materialized.materialization.outputPath,
          ...(continuationKey ? { sessionPath: continuationKey } : {}),
        })
        piSession.setPermissionHandler(permissionHandler)
        session = piSession
      }

      const turnPromise = new Promise<void>((resolve, reject) => {
        if (!session) return
        session.onEvent((event: UnifiedSessionEvent) => {
          const result = mapUnifiedEvents(
            event,
            (mapped) => {
              void eventEmitter.emit(mapped)
            },
            (key) => {
              continuationKey = key
              eventEmitter.setContinuation({
                provider: runtimePlan.provider,
                key,
              })
            },
            assistantState,
            { allowSessionIdUpdate: frontendDef.frontend !== PI_SDK_FRONTEND }
          )

          if (result.turnEnded && !turnEnded) {
            turnEnded = true
            void eventEmitter.idle().then(resolve, reject)
          }
        })
      })

      await runSession(session, resolvedPrompt, req.attachments, runId as string)
      await turnPromise
      await session.stop('complete')
      await eventEmitter.idle()
      finalOutput = assistantState.lastAssistantText
    } finally {
      restoreEnv()
    }

    const result: RunResult = { success: true, ...(finalOutput ? { finalOutput } : {}) }
    await eventEmitter.emit({ type: 'state', state: 'complete' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)

    const finalContinuation: HarnessContinuationRef | undefined = continuationKey
      ? { provider: runtimePlan.provider, key: continuationKey }
      : undefined

    return {
      ...(finalContinuation ? { continuation: finalContinuation } : {}),
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.info.effectiveModel,
      result,
      resolvedBundle,
    }
  } catch (error) {
    if (session) {
      try {
        await session.stop('error')
      } catch {
        // Ignore cleanup failures.
      }
    }

    const result: RunResult = {
      success: false,
      error: toAgentSpacesError(error, 'resolve_failed'),
    }
    await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
    await eventEmitter.emit({ type: 'complete', result } as EventPayload)

    const finalContinuation: HarnessContinuationRef | undefined = continuationKey
      ? { provider: runtimePlan.provider, key: continuationKey }
      : undefined

    return {
      ...(finalContinuation ? { continuation: finalContinuation } : {}),
      provider: runtimePlan.provider,
      frontend: req.frontend,
      model: runtimePlan.model.ok ? runtimePlan.model.info.effectiveModel : req.model,
      result,
    }
  }
}
