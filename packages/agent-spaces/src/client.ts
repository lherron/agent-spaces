import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import {
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
  getRegistryPath,
  lintSpaces,
  readHooksWithPrecedence,
  resolveTarget,
} from 'spaces-config'

import {
  type PermissionHandler,
  PiSession,
  type UnifiedSession,
  type UnifiedSessionEvent,
  createSession,
  harnessRegistry,
  loadPiSdkBundle,
  materializeFromRefs,
  materializeTarget,
} from 'spaces-execution'

import type {
  AgentEvent,
  AgentSpacesClient,
  AgentSpacesError,
  BuildProcessInvocationSpecRequest,
  BuildProcessInvocationSpecResponse,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  HarnessContinuationRef,
  HarnessFrontend,
  ProcessInvocationSpec,
  ProviderDomain,
  ResolveRequest,
  ResolveResponse,
  RunResult,
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

const AGENT_SDK_INTERNAL: HarnessId = 'claude-agent-sdk'
const PI_SDK_INTERNAL: HarnessId = 'pi-sdk'
const CLAUDE_CODE_INTERNAL: HarnessId = 'claude'
const CODEX_CLI_INTERNAL: HarnessId = 'codex'

const AGENT_SDK_MODELS = ['claude/opus', 'claude/haiku', 'claude/sonnet', 'claude/claude-opus-4-5']

const PI_SDK_MODELS = [
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
  'api/gpt-5.2-codex',
  'api/gpt-5.2',
]

const CLAUDE_CODE_MODELS = [
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-haiku-4-5',
  'opus',
  'sonnet',
  'haiku',
]

const CODEX_CLI_MODELS = [
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

const DEFAULT_AGENT_SDK_MODEL = 'claude/sonnet'
const DEFAULT_PI_SDK_MODEL = 'openai-codex/gpt-5.2-codex'
const DEFAULT_CLAUDE_CODE_MODEL = 'claude-opus-4-5'
const DEFAULT_CODEX_CLI_MODEL = 'gpt-5.2-codex'

interface FrontendDef {
  provider: ProviderDomain
  internalId: HarnessId
  models: string[]
  defaultModel: string
}

const FRONTEND_DEFS = new Map<HarnessFrontend, FrontendDef>([
  [
    AGENT_SDK_FRONTEND,
    {
      provider: 'anthropic',
      internalId: AGENT_SDK_INTERNAL,
      models: AGENT_SDK_MODELS,
      defaultModel: DEFAULT_AGENT_SDK_MODEL,
    },
  ],
  [
    PI_SDK_FRONTEND,
    {
      provider: 'openai',
      internalId: PI_SDK_INTERNAL,
      models: PI_SDK_MODELS,
      defaultModel: DEFAULT_PI_SDK_MODEL,
    },
  ],
  [
    CLAUDE_CODE_FRONTEND,
    {
      provider: 'anthropic',
      internalId: CLAUDE_CODE_INTERNAL,
      models: CLAUDE_CODE_MODELS,
      defaultModel: DEFAULT_CLAUDE_CODE_MODEL,
    },
  ],
  [
    CODEX_CLI_FRONTEND,
    {
      provider: 'openai',
      internalId: CODEX_CLI_INTERNAL,
      models: CODEX_CLI_MODELS,
      defaultModel: DEFAULT_CODEX_CLI_MODEL,
    },
  ],
])

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

type EventPayload = Omit<AgentEvent, 'ts' | 'seq' | 'cpSessionId' | 'runId' | 'continuation'>

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
    throw new Error(`Unsupported frontend: ${frontend}`)
  }
  return { ...def, frontend }
}

function validateProviderMatch(
  frontendDef: FrontendDef & { frontend: HarnessFrontend },
  continuation: HarnessContinuationRef | undefined
): void {
  if (continuation && continuation.provider !== frontendDef.provider) {
    throw new Error(
      `Provider mismatch: frontend "${frontendDef.frontend}" is provider "${frontendDef.provider}" but continuation is provider "${continuation.provider}"`
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

function normalizeAgentSdkModel(model: string): 'haiku' | 'sonnet' | 'opus' | 'opus-4-5' {
  switch (model) {
    case 'haiku':
    case 'sonnet':
    case 'opus':
    case 'opus-4-5':
      return model
    case 'claude-opus-4-5':
      return 'opus-4-5'
    default:
      throw new Error(`Unsupported agent-sdk model: ${model}`)
  }
}

// ---------------------------------------------------------------------------
// Helpers: pi session path (deterministic, stateless)
// ---------------------------------------------------------------------------

function piSessionPath(aspHome: string, cpSessionId: string): string {
  const hash = createHash('sha256')
  hash.update(cpSessionId)
  return join(aspHome, 'sessions', 'pi', hash.digest('hex'))
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
  registryPathOverride?: string | undefined
): Promise<MaterializedSpec> {
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
  const details: Record<string, unknown> = {}
  if (error instanceof Error && error.stack) {
    details['stack'] = error.stack
  }
  return {
    message,
    ...(code ? { code } : {}),
    ...(Object.keys(details).length > 0 ? { details } : {}),
  }
}

// ---------------------------------------------------------------------------
// Helpers: environment overlay
// ---------------------------------------------------------------------------

function applyEnvOverlay(env: Record<string, string>): () => void {
  const prior = new Map<string, string | undefined>()

  for (const [key, value] of Object.entries(env)) {
    prior.set(key, process.env[key])
    process.env[key] = value
  }

  return () => {
    for (const [key, value] of prior.entries()) {
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  }
}

async function withAspHome<T>(aspHome: string, fn: () => Promise<T>): Promise<T> {
  const restore = applyEnvOverlay({ ASP_HOME: aspHome })
  try {
    return await fn()
  } finally {
    restore()
  }
}

// ---------------------------------------------------------------------------
// Helpers: event emitter (updated for cpSessionId / runId / continuation)
// ---------------------------------------------------------------------------

function createEventEmitter(
  onEvent: (event: AgentEvent) => void | Promise<void>,
  base: {
    cpSessionId: string
    runId: string
  },
  continuation?: HarnessContinuationRef
): {
  emit: (event: EventPayload) => Promise<void>
  setContinuation: (ref: HarnessContinuationRef) => void
  getContinuation: () => HarnessContinuationRef | undefined
  idle: () => Promise<void>
} {
  let seq = 0
  let currentContinuation = continuation
  let lastEmission = Promise.resolve()

  const emit = async (event: EventPayload): Promise<void> => {
    seq += 1
    const fullEvent: AgentEvent = {
      ...(event as AgentEvent),
      ts: new Date().toISOString(),
      seq,
      cpSessionId: base.cpSessionId,
      runId: base.runId,
      ...(currentContinuation ? { continuation: currentContinuation } : {}),
    }

    lastEmission = lastEmission.then(() => Promise.resolve(onEvent(fullEvent)))
    void lastEmission.catch(() => {})
    return lastEmission
  }

  return {
    emit,
    setContinuation: (ref: HarnessContinuationRef) => {
      currentContinuation = ref
    },
    getContinuation: () => currentContinuation,
    idle: () => lastEmission,
  }
}

// ---------------------------------------------------------------------------
// Helpers: unified event mapping
// ---------------------------------------------------------------------------

function mapContentToText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const textParts: string[] = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const blockObj = block as { type?: string; text?: string }
    if (blockObj.type === 'text' && typeof blockObj.text === 'string') {
      textParts.push(blockObj.text)
    }
  }
  if (textParts.length === 0) return undefined
  return textParts.join('')
}

function mapUnifiedEvents(
  event: UnifiedSessionEvent,
  emit: (event: EventPayload) => void,
  onContinuationKeyObserved: (key: string) => void,
  state: { assistantBuffer: string; lastAssistantText?: string | undefined },
  options: { allowSessionIdUpdate: boolean }
): { turnEnded: boolean } {
  switch (event.type) {
    case 'agent_start': {
      const sdkSid = (event as { sdkSessionId?: unknown }).sdkSessionId
      const sessionId = typeof sdkSid === 'string' ? sdkSid : event.sessionId
      if (sessionId && options.allowSessionIdUpdate) {
        onContinuationKeyObserved(sessionId)
      }
      return { turnEnded: false }
    }
    case 'sdk_session_id': {
      const sdkSid = (event as { sdkSessionId?: string }).sdkSessionId
      if (sdkSid && options.allowSessionIdUpdate) {
        onContinuationKeyObserved(sdkSid)
      }
      return { turnEnded: false }
    }
    case 'message_start':
      if (event.message.role === 'assistant') {
        state.assistantBuffer = ''
      }
      return { turnEnded: false }
    case 'message_update': {
      if (event.textDelta && event.textDelta.length > 0) {
        state.assistantBuffer += event.textDelta
        emit({
          type: 'message_delta',
          role: 'assistant',
          delta: event.textDelta,
          payload: event.payload,
        } as EventPayload)
      } else if (event.contentBlocks) {
        const text = mapContentToText(event.contentBlocks)
        if (text) {
          state.assistantBuffer += text
          emit({
            type: 'message_delta',
            role: 'assistant',
            delta: text,
            payload: event.payload,
          } as EventPayload)
        }
      }
      return { turnEnded: false }
    }
    case 'message_end': {
      if (event.message?.role !== 'assistant') return { turnEnded: false }
      const content = mapContentToText(event.message.content)
      const finalText = content ?? state.assistantBuffer
      if (finalText) {
        state.lastAssistantText = finalText
        emit({
          type: 'message',
          role: 'assistant',
          content: finalText,
          payload: event.payload,
        } as EventPayload)
      }
      return { turnEnded: false }
    }
    case 'tool_execution_start':
      emit({
        type: 'tool_call',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        input: event.input,
        payload: event.payload,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      } as EventPayload)
      return { turnEnded: false }
    case 'tool_execution_end':
      emit({
        type: 'tool_result',
        toolUseId: event.toolUseId,
        toolName: event.toolName,
        output: event.result,
        isError: event.isError === true,
        payload: event.payload,
        ...(event.parentToolUseId ? { parentToolUseId: event.parentToolUseId } : {}),
      } as EventPayload)
      return { turnEnded: false }
    case 'turn_end':
      return { turnEnded: true }
    case 'agent_end':
      return { turnEnded: true }
    default:
      return { turnEnded: false }
  }
}

function buildAutoPermissionHandler(): PermissionHandler {
  return {
    isAutoAllowed: () => true,
    requestPermission: async () => ({ allowed: true }),
  }
}

async function runSession(
  session: UnifiedSession,
  prompt: string,
  attachments: string[] | undefined,
  runId: string
): Promise<void> {
  const attachmentRefs = attachments?.map((path) => ({
    kind: 'file' as const,
    path,
    filename: basename(path),
  }))

  await session.start()
  await session.sendPrompt(prompt, {
    ...(attachmentRefs ? { attachments: attachmentRefs } : {}),
    runId,
  })
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

export function createAgentSpacesClient(): AgentSpacesClient {
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
        const materialized = await materializeSpec(
          spec,
          req.aspHome,
          frontendDef.internalId,
          req.registryPath
        )
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
            { paramName: 'sessionId', paramValue: req.cpSessionId ?? null },
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
        harnesses: [
          {
            id: 'anthropic',
            provider: 'anthropic',
            frontends: [AGENT_SDK_FRONTEND, CLAUDE_CODE_FRONTEND],
            models: [...AGENT_SDK_MODELS, ...CLAUDE_CODE_MODELS],
          },
          {
            id: 'openai',
            provider: 'openai',
            frontends: [PI_SDK_FRONTEND, CODEX_CLI_FRONTEND],
            models: [...PI_SDK_MODELS, ...CODEX_CLI_MODELS],
          },
        ],
      }
    },

    async buildProcessInvocationSpec(
      req: BuildProcessInvocationSpecRequest
    ): Promise<BuildProcessInvocationSpecResponse> {
      return withAspHome(req.aspHome, async () => {
        const warnings: string[] = []
        const spec = validateSpec(req.spec)
        const frontendDef = resolveFrontend(req.frontend)

        // Validate provider matches frontend
        if (req.provider !== frontendDef.provider) {
          throw new Error(
            `Provider mismatch: frontend "${req.frontend}" requires provider "${frontendDef.provider}" but got "${req.provider}"`
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
          ...(isResume && req.continuation?.key ? { resume: req.continuation.key } : {}),
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

    async runTurnNonInteractive(
      req: RunTurnNonInteractiveRequest
    ): Promise<RunTurnNonInteractiveResponse> {
      return withAspHome(req.aspHome, async () => {
        const frontendDef = resolveFrontend(req.frontend)
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { cpSessionId: req.cpSessionId, runId: req.runId },
          req.continuation
        )

        let spec: ValidatedSpec
        let modelResolution: ReturnType<typeof resolveModel>
        let continuationKey = req.continuation?.key

        try {
          spec = validateSpec(req.spec)

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
          continuationKey = piSessionPath(req.aspHome, req.cpSessionId)
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
                sessionId: continuationKey ?? req.cpSessionId,
                cwd: req.cwd,
                model: normalizeAgentSdkModel(modelResolution.info.model),
                plugins,
                permissionHandler,
                ...(isResume && continuationKey ? { resume: continuationKey } : {}),
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
                ownerId: req.cpSessionId,
                cwd: req.cwd,
                provider: modelResolution.info.provider,
                model: modelResolution.info.model,
                sessionId: req.cpSessionId,
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
