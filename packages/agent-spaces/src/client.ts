import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, readFile, readdir, stat, symlink } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'

import {
  type HarnessId,
  type LintWarning,
  type LockFile,
  PathResolver,
  type SpaceRefString,
  asSha256Integrity,
  asSpaceId,
  atomicWriteJson,
  computeClosure,
  copyDir,
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
  loadPiSdkBundle,
  materializeFromRefs,
  materializeTarget,
} from 'spaces-execution'

import type {
  AgentEvent,
  AgentSpacesClient,
  AgentSpacesError,
  DescribeRequest,
  DescribeResponse,
  HarnessCapabilities,
  ResolveRequest,
  ResolveResponse,
  RunResult,
  RunTurnRequest,
  RunTurnResponse,
  SpaceSpec,
} from './types.js'

const AGENT_SDK_HARNESS = 'agent-sdk'
const PI_SDK_HARNESS = 'pi-sdk'
const CODEX_HARNESS = 'codex'

const AGENT_SDK_INTERNAL: HarnessId = 'claude-agent-sdk'
const PI_SDK_INTERNAL: HarnessId = 'pi-sdk'
const CODEX_INTERNAL: HarnessId = 'codex'

const AGENT_SDK_MODELS = [
  // 'api/opus',
  // 'api/haiku',
  // 'api/sonnet',
  'claude/opus',
  'claude/haiku',
  'claude/sonnet',
  'claude/claude-opus-4-5',
]

const PI_SDK_MODELS = [
  'openai-codex/gpt-5.2-codex',
  'openai-codex/gpt-5.2',
  'api/gpt-5.2-codex',
  'api/gpt-5.2',
]

const CODEX_MODELS = [
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
const DEFAULT_CODEX_MODEL = 'gpt-5.2-codex'

const HARNESS_DEFS = new Map<
  string,
  { internalId: HarnessId; models: string[]; defaultModel: string }
>([
  [
    AGENT_SDK_HARNESS,
    {
      internalId: AGENT_SDK_INTERNAL,
      models: AGENT_SDK_MODELS,
      defaultModel: DEFAULT_AGENT_SDK_MODEL,
    },
  ],
  [
    PI_SDK_HARNESS,
    {
      internalId: PI_SDK_INTERNAL,
      models: PI_SDK_MODELS,
      defaultModel: DEFAULT_PI_SDK_MODEL,
    },
  ],
  [
    CODEX_HARNESS,
    {
      internalId: CODEX_INTERNAL,
      models: CODEX_MODELS,
      defaultModel: DEFAULT_CODEX_MODEL,
    },
  ],
])

interface ValidatedSpec {
  kind: 'spaces' | 'target'
  spaces?: string[]
  targetName?: string
  targetDir?: string
}

interface SessionRecord {
  externalSessionId: string
  harness: string
  harnessSessionId?: string | undefined
  model?: string | undefined
  createdAt: string
  updatedAt: string
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

type EventPayload = Omit<
  AgentEvent,
  'ts' | 'seq' | 'externalSessionId' | 'externalRunId' | 'harnessSessionId'
>

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

async function prepareSessionContext(
  req: RunTurnRequest,
  harnessDef: ReturnType<typeof resolveHarness>,
  record: SessionRecord | null
): Promise<{
  harnessSessionId: string | undefined
  isResume: boolean
  codexSessionHome: string | undefined
}> {
  const isResume = req.harnessSessionId !== undefined || record?.harnessSessionId !== undefined
  let harnessSessionId = req.harnessSessionId ?? record?.harnessSessionId
  if (harnessDef.externalId === PI_SDK_HARNESS && !harnessSessionId) {
    harnessSessionId = piSessionPath(req.aspHome, req.externalSessionId)
  }

  let codexSessionHome: string | undefined
  if (harnessDef.externalId === CODEX_HARNESS) {
    codexSessionHome = codexSessionPath(req.aspHome, req.externalSessionId)
  }

  if (harnessDef.externalId === PI_SDK_HARNESS && !isResume && harnessSessionId) {
    await ensureDir(harnessSessionId)
  }

  return { harnessSessionId, isResume, codexSessionHome }
}

function sessionRecordPath(aspHome: string, externalSessionId: string): string {
  const hash = createHash('sha256')
  hash.update(externalSessionId)
  return join(aspHome, 'sessions', `${hash.digest('hex')}.json`)
}

function piSessionPath(aspHome: string, externalSessionId: string): string {
  const hash = createHash('sha256')
  hash.update(externalSessionId)
  return join(aspHome, 'sessions', 'pi', hash.digest('hex'))
}

function codexSessionPath(aspHome: string, externalSessionId: string): string {
  const hash = createHash('sha256')
  hash.update(externalSessionId)
  return join(aspHome, 'sessions', 'codex', hash.digest('hex'), 'home')
}

async function linkOrCopyEntry(src: string, dest: string): Promise<void> {
  if (existsSync(dest)) return
  try {
    await symlink(src, dest)
  } catch {
    const srcStats = await stat(src)
    if (srcStats.isDirectory()) {
      await copyDir(src, dest, { useHardlinks: false })
    } else {
      await copyFile(src, dest)
    }
  }
}

async function ensureCodexSessionHome(templateDir: string, sessionHome: string): Promise<void> {
  if (!existsSync(templateDir)) {
    throw new Error(`Codex template directory not found: ${templateDir}`)
  }

  await ensureDir(sessionHome)

  const configSrc = join(templateDir, 'config.toml')
  const configDest = join(sessionHome, 'config.toml')
  if (!existsSync(configSrc)) {
    throw new Error(`Codex template missing config.toml: ${configSrc}`)
  }
  if (!existsSync(configDest)) {
    await copyFile(configSrc, configDest)
  }

  const agentsSrc = join(templateDir, 'AGENTS.md')
  const agentsDest = join(sessionHome, 'AGENTS.md')
  if (existsSync(agentsSrc) && !existsSync(agentsDest)) {
    await linkOrCopyEntry(agentsSrc, agentsDest)
  }

  // Symlink auth.json from template (which points to ~/.codex/auth.json) for OAuth
  const authSrc = join(templateDir, 'auth.json')
  const authDest = join(sessionHome, 'auth.json')
  if (existsSync(authSrc) && !existsSync(authDest)) {
    await linkOrCopyEntry(authSrc, authDest)
  }

  const skillsSrc = join(templateDir, 'skills')
  const skillsDest = join(sessionHome, 'skills')
  await ensureDir(skillsDest)
  if (existsSync(skillsSrc)) {
    const entries = await readdir(skillsSrc, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      await linkOrCopyEntry(join(skillsSrc, entry.name), join(skillsDest, entry.name))
    }
  }

  const promptsSrc = join(templateDir, 'prompts')
  const promptsDest = join(sessionHome, 'prompts')
  await ensureDir(promptsDest)
  if (existsSync(promptsSrc)) {
    const entries = await readdir(promptsSrc, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.md')) continue
      await linkOrCopyEntry(join(promptsSrc, entry.name), join(promptsDest, entry.name))
    }
  }
}

async function readSessionRecord(
  aspHome: string,
  externalSessionId: string
): Promise<SessionRecord | null> {
  const path = sessionRecordPath(aspHome, externalSessionId)
  if (!existsSync(path)) {
    return null
  }

  const raw = await readFile(path, 'utf-8')
  return JSON.parse(raw) as SessionRecord
}

async function writeSessionRecord(aspHome: string, record: SessionRecord): Promise<void> {
  const path = sessionRecordPath(aspHome, record.externalSessionId)
  await atomicWriteJson(path, record)
}

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

function resolveHarness(harness: string): {
  externalId: string
  internalId: HarnessId
  models: string[]
  defaultModel: string
} {
  const def = HARNESS_DEFS.get(harness)
  if (!def) {
    throw new Error(`Unsupported harness: ${harness}`)
  }
  return {
    externalId: harness,
    internalId: def.internalId,
    models: def.models,
    defaultModel: def.defaultModel,
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
  harness: { models: string[]; defaultModel: string },
  requested: string | undefined
): { ok: true; info: ModelInfo } | { ok: false; modelId: string } {
  const modelId = requested ?? harness.defaultModel
  if (!harness.models.includes(modelId)) {
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
    throw new Error(`Target not found in lock: ${targetName}`)
  }

  const paths = new PathResolver({ aspHome })
  const lintData = target.loadOrder.map((key) => {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space entry not found in lock: ${key}`)
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

function createEventEmitter(
  onEvent: (event: AgentEvent) => void | Promise<void>,
  base: {
    externalSessionId: string
    externalRunId: string
  },
  harnessSessionId?: string
): {
  emit: (event: EventPayload) => Promise<void>
  setHarnessSessionId: (id: string) => void
  idle: () => Promise<void>
} {
  let seq = 0
  let currentHarnessSessionId = harnessSessionId
  let lastEmission = Promise.resolve()

  const emit = async (event: EventPayload): Promise<void> => {
    seq += 1
    const fullEvent: AgentEvent = {
      ...(event as AgentEvent),
      ts: new Date().toISOString(),
      seq,
      externalSessionId: base.externalSessionId,
      externalRunId: base.externalRunId,
      ...(currentHarnessSessionId ? { harnessSessionId: currentHarnessSessionId } : {}),
    }

    lastEmission = lastEmission.then(() => Promise.resolve(onEvent(fullEvent)))
    void lastEmission.catch(() => {})
    return lastEmission
  }

  return {
    emit,
    setHarnessSessionId: (id: string) => {
      currentHarnessSessionId = id
    },
    idle: () => lastEmission,
  }
}

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
  setHarnessSessionId: (id: string) => void,
  state: { assistantBuffer: string; lastAssistantText?: string | undefined },
  options: { allowSessionIdUpdate: boolean }
): { turnEnded: boolean } {
  switch (event.type) {
    case 'agent_start': {
      const sdkSid = (event as { sdkSessionId?: unknown }).sdkSessionId
      const sessionId = typeof sdkSid === 'string' ? sdkSid : event.sessionId
      if (sessionId && options.allowSessionIdUpdate) {
        setHarnessSessionId(sessionId)
      }
      return { turnEnded: false }
    }
    case 'sdk_session_id': {
      const sdkSid = (event as { sdkSessionId?: string }).sdkSessionId
      if (sdkSid && options.allowSessionIdUpdate) {
        setHarnessSessionId(sdkSid)
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
        const harnessDef = req.harness
          ? resolveHarness(req.harness)
          : resolveHarness(AGENT_SDK_HARNESS)
        const materialized = await materializeSpec(
          spec,
          req.aspHome,
          harnessDef.internalId,
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

        if (harnessDef.externalId === AGENT_SDK_HARNESS) {
          const modelResolution = resolveModel(harnessDef, req.model)
          if (!modelResolution.ok) {
            throw new Error(
              `Model not supported for harness ${harnessDef.externalId}: ${modelResolution.modelId}`
            )
          }
          const plugins = materialized.materialization.pluginDirs.map((dir) => ({
            type: 'local' as const,
            path: dir,
          }))
          response.agentSdkSessionParams = [
            { paramName: 'kind', paramValue: 'agent-sdk' },
            { paramName: 'sessionId', paramValue: req.sessionId ?? null },
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
          { id: AGENT_SDK_HARNESS, models: [...AGENT_SDK_MODELS] },
          { id: PI_SDK_HARNESS, models: [...PI_SDK_MODELS] },
          { id: CODEX_HARNESS, models: [...CODEX_MODELS] },
        ],
      }
    },

    async runTurn(req: RunTurnRequest): Promise<RunTurnResponse> {
      return withAspHome(req.aspHome, async () => {
        const eventEmitter = createEventEmitter(
          req.callbacks.onEvent,
          { externalSessionId: req.externalSessionId, externalRunId: req.externalRunId },
          req.harnessSessionId
        )

        let spec: ValidatedSpec
        let harnessDef: ReturnType<typeof resolveHarness>
        let modelResolution: ReturnType<typeof resolveModel>
        let harnessSessionId = req.harnessSessionId
        let codexSessionHome: string | undefined

        try {
          spec = validateSpec(req.spec)
          harnessDef = resolveHarness(req.harness)
          modelResolution = resolveModel(harnessDef, req.model)
        } catch (error) {
          const result: RunResult = { success: false, error: toAgentSpacesError(error) }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            harness: req.harness,
            model: req.model,
            harnessSessionId,
            result,
          }
        }

        const record = await readSessionRecord(req.aspHome, req.externalSessionId)
        if (record && record.harness !== harnessDef.externalId) {
          const error = toAgentSpacesError(
            new Error(
              `Harness mismatch for session ${req.externalSessionId}: expected ${record.harness}, got ${harnessDef.externalId}`
            )
          )
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            harness: req.harness,
            model: req.model,
            harnessSessionId: record.harnessSessionId,
            result,
          }
        }

        const sessionContext = await prepareSessionContext(req, harnessDef, record)
        const isResume = sessionContext.isResume
        harnessSessionId = sessionContext.harnessSessionId
        codexSessionHome = sessionContext.codexSessionHome

        if (harnessSessionId) {
          eventEmitter.setHarnessSessionId(harnessSessionId)
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
              `Model not supported for harness ${harnessDef.externalId}: ${modelResolution.modelId}`
            ),
            'model_not_supported'
          )
          const result: RunResult = { success: false, error }
          await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
          await eventEmitter.emit({ type: 'complete', result } as EventPayload)
          return {
            harness: req.harness,
            model: modelResolution.modelId,
            harnessSessionId,
            result,
          }
        }

        if (harnessDef.externalId === PI_SDK_HARNESS && isResume && harnessSessionId) {
          if (!existsSync(harnessSessionId)) {
            const error = toAgentSpacesError(
              new Error(`Harness session not found: ${harnessSessionId}`),
              'harness_session_not_found'
            )
            const result: RunResult = { success: false, error }
            await eventEmitter.emit({ type: 'state', state: 'error' } as EventPayload)
            await eventEmitter.emit({ type: 'complete', result } as EventPayload)
            return {
              harness: req.harness,
              model: modelResolution.info.effectiveModel,
              harnessSessionId,
              result,
            }
          }
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
          const materialized = await materializeSpec(spec, req.aspHome, harnessDef.internalId)

          const harnessEnv: Record<string, string> = { ...(req.env ?? {}) }
          let codexTemplateDir: string | undefined
          if (harnessDef.externalId === PI_SDK_HARNESS) {
            harnessEnv['PI_CODING_AGENT_DIR'] = materialized.materialization.outputPath
          }
          if (harnessDef.externalId === CODEX_HARNESS) {
            codexTemplateDir = join(materialized.materialization.outputPath, 'codex.home')
            const sessionHome =
              codexSessionHome ?? codexSessionPath(req.aspHome, req.externalSessionId)
            codexSessionHome = sessionHome
            await ensureCodexSessionHome(codexTemplateDir, sessionHome)
            harnessEnv['CODEX_HOME'] = sessionHome
          }

          const restoreEnv = applyEnvOverlay(harnessEnv)
          try {
            if (harnessDef.externalId === AGENT_SDK_HARNESS) {
              const plugins = materialized.materialization.pluginDirs.map((dir) => ({
                type: 'local' as const,
                path: dir,
              }))
              session = createSession({
                kind: 'agent-sdk',
                sessionId: harnessSessionId ?? req.externalSessionId,
                cwd: req.cwd,
                model: normalizeAgentSdkModel(modelResolution.info.model),
                plugins,
                permissionHandler,
                // Pass resume to load conversation history from previous session
                ...(isResume && harnessSessionId ? { resume: harnessSessionId } : {}),
              })
            } else if (harnessDef.externalId === CODEX_HARNESS) {
              if (!codexSessionHome) {
                throw new Error('Codex session home is missing')
              }
              session = createSession({
                kind: 'codex',
                sessionId: req.externalSessionId,
                cwd: req.cwd,
                codexHomeDir: codexSessionHome,
                ...(codexTemplateDir ? { codexTemplateDir } : {}),
                codexModel: modelResolution.info.model,
                codexCwd: req.cwd,
                permissionHandler,
                ...(isResume && harnessSessionId ? { resume: harnessSessionId } : {}),
              })
            } else {
              const bundle = await loadPiSdkBundle(materialized.materialization.outputPath, {
                cwd: req.cwd,
                yolo: true,
                noExtensions: false,
                noSkills: false,
                agentDir: materialized.materialization.outputPath,
              })
              const piSession = new PiSession({
                ownerId: req.externalSessionId,
                cwd: req.cwd,
                provider: modelResolution.info.provider,
                model: modelResolution.info.model,
                sessionId: req.externalSessionId,
                extensions: bundle.extensions,
                skills: bundle.skills,
                contextFiles: bundle.contextFiles,
                agentDir: materialized.materialization.outputPath,
                ...(harnessSessionId ? { sessionPath: harnessSessionId } : {}),
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
                  (id) => {
                    harnessSessionId = id
                    eventEmitter.setHarnessSessionId(id)
                  },
                  assistantState,
                  { allowSessionIdUpdate: harnessDef.externalId !== PI_SDK_HARNESS }
                )

                if (result.turnEnded && !turnEnded) {
                  turnEnded = true
                  void eventEmitter.idle().then(resolve, reject)
                }
              })
            })

            await runSession(session, req.prompt, req.attachments, req.externalRunId)
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

          const now = new Date().toISOString()
          const updatedRecord: SessionRecord = {
            externalSessionId: req.externalSessionId,
            harness: harnessDef.externalId,
            harnessSessionId,
            model: modelResolution.info.effectiveModel,
            createdAt: record?.createdAt ?? now,
            updatedAt: now,
          }
          await writeSessionRecord(req.aspHome, updatedRecord)

          return {
            harness: req.harness,
            model: modelResolution.info.effectiveModel,
            harnessSessionId,
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

          return {
            harness: req.harness,
            model: modelResolution.ok ? modelResolution.info.effectiveModel : req.model,
            harnessSessionId,
            result,
          }
        }
      })
    },
  }
}
