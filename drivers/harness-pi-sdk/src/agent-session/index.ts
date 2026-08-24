import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type AgentSession,
  type BashSpawnHook,
  DefaultResourceLoader,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  createAgentSession,
  createBashToolDefinition,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'

export type {
  AgentSession,
  AgentSessionEvent,
  ExtensionFactory,
  InlineExtension,
  ToolDefinition,
} from '@earendil-works/pi-coding-agent'

export interface PiAgentSessionAuth {
  authMode: 'api-key' | 'oauth'
  authPath: string
  providerId: string
}

export class PiAgentSessionAuthError extends Error {
  constructor(
    readonly code: 'missing_auth_store' | 'auth_mode_mismatch',
    message: string
  ) {
    super(message)
    this.name = 'PiAgentSessionAuthError'
  }
}

export interface ResolvedPiAgentSessionAuth extends PiAgentSessionAuth {
  credentialType: 'api-key' | 'oauth'
  storeBound: boolean
}

export async function resolvePiAgentSessionAuth(options: {
  authMode: 'api-key' | 'oauth'
  providerId: string
  agentDir: string
  authStorePath?: string | undefined
}): Promise<ResolvedPiAgentSessionAuth> {
  if (options.authMode === 'api-key') {
    return {
      authMode: 'api-key',
      authPath: join(options.agentDir, 'auth.json'),
      providerId: options.providerId,
      credentialType: 'api-key',
      storeBound: false,
    }
  }
  const authPath = options.authStorePath
  if (authPath === undefined || authPath.trim().length === 0) {
    throw new PiAgentSessionAuthError(
      'missing_auth_store',
      'OAuth mode requires an explicit Pi auth store path'
    )
  }
  try {
    JSON.parse(await readFile(authPath, 'utf8'))
  } catch {
    throw new PiAgentSessionAuthError(
      'missing_auth_store',
      `OAuth auth store is missing or unreadable: ${authPath}`
    )
  }
  const credential = readStoredCredential(options.providerId, authPath)
  if (credential?.type !== 'oauth') {
    throw new PiAgentSessionAuthError(
      'auth_mode_mismatch',
      `OAuth auth store credential for provider ${options.providerId} is not OAuth-typed`
    )
  }
  return {
    authMode: 'oauth',
    authPath,
    providerId: options.providerId,
    credentialType: 'oauth',
    storeBound: true,
  }
}

export interface CreatePiAgentSessionOptions {
  cwd: string
  agentDir: string
  model: {
    provider: string
    modelId: string
    thinkingLevel?: string | undefined
  }
  auth: PiAgentSessionAuth
  environment: NodeJS.ProcessEnv
  systemPrompt?:
    | {
        content: string
        mode: 'append' | 'replace'
      }
    | undefined
  appendSystemPrompt?: string[] | undefined
  skillPaths?: string[] | undefined
  extensionFactories?: InlineExtension[] | undefined
  customTools?: ToolDefinition[] | undefined
  continuationKey?: string | undefined
}

/**
 * Construct the Pi resource loader used by both production session creation
 * and resource inspection. Callers that inspect its selected resources must
 * call reload() before getSkills(), matching createPiAgentSession().
 */
export function createPiAgentResourceLoader(
  options: CreatePiAgentSessionOptions,
  settingsManager: ReturnType<typeof SettingsManager.inMemory>
): DefaultResourceLoader {
  return new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    extensionFactories: options.extensionFactories ?? [],
    additionalSkillPaths: options.skillPaths ?? [],
    noExtensions: true,
    noSkills: false,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    ...(options.systemPrompt?.mode === 'append' || (options.appendSystemPrompt?.length ?? 0) > 0
      ? {
          appendSystemPrompt: [
            ...(options.systemPrompt?.mode === 'append' ? [options.systemPrompt.content] : []),
            ...(options.appendSystemPrompt ?? []),
          ],
        }
      : {}),
    ...(options.systemPrompt !== undefined && options.systemPrompt.mode === 'replace'
      ? { systemPrompt: options.systemPrompt.content }
      : {}),
  })
}

interface PiProviderRegistry {
  getProvider(providerId: string): unknown | undefined
}

export interface PiModelReference {
  providerId: string
  modelId: string
}

export function resolvePiModelReference(
  registry: PiProviderRegistry,
  provider: string,
  modelId: string
): PiModelReference {
  const separator = modelId.indexOf('/')
  if (separator > 0 && separator < modelId.length - 1) {
    const qualifiedProvider = modelId.slice(0, separator)
    if (registry.getProvider(qualifiedProvider) !== undefined) {
      return { providerId: qualifiedProvider, modelId: modelId.slice(separator + 1) }
    }
  }
  const prefix = `${provider}/`
  return {
    providerId: provider,
    modelId: modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId,
  }
}

export async function createPiAgentSession(
  options: CreatePiAgentSessionOptions
): Promise<AgentSession> {
  await mkdir(options.agentDir, { recursive: true })
  const modelRuntime = await ModelRuntime.create({
    authPath: options.auth.authPath,
    modelsPath: join(options.agentDir, 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const modelReference = resolvePiModelReference(
    modelRuntime,
    options.model.provider,
    options.model.modelId
  )
  if (modelReference.providerId !== options.auth.providerId) {
    throw new Error(
      `Resolved pi provider ${modelReference.providerId} does not match authenticated provider ${options.auth.providerId}`
    )
  }
  if (options.auth.authMode === 'api-key') {
    const credential = providerCredential(options.auth.providerId, options.environment)
    if (credential !== undefined) {
      await modelRuntime.setRuntimeApiKey(options.auth.providerId, credential)
    }
  }
  const model = modelRuntime.getModel(modelReference.providerId, modelReference.modelId)
  if (model === undefined) {
    throw new Error(`Unknown pi model: ${modelReference.providerId}/${modelReference.modelId}`)
  }

  const settingsManager = SettingsManager.inMemory()
  const resourceLoader = createPiAgentResourceLoader(options, settingsManager)
  await resourceLoader.reload()

  const spawnHook: BashSpawnHook = (context) => ({
    ...context,
    cwd: options.cwd,
    env: { ...options.environment },
  })
  const bashTool = createBashToolDefinition(options.cwd, {
    spawnHook,
    exposeSessionEnvironment: false,
  })
  const sessionManager =
    options.continuationKey !== undefined
      ? SessionManager.open(options.continuationKey, undefined, options.cwd)
      : SessionManager.create(options.cwd)
  const created = await createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    modelRuntime,
    model,
    ...(options.model.thinkingLevel !== undefined
      ? { thinkingLevel: options.model.thinkingLevel as never }
      : {}),
    sessionManager,
    settingsManager,
    resourceLoader,
    customTools: [bashTool as unknown as ToolDefinition, ...(options.customTools ?? [])],
  })
  return created.session
}

function providerCredential(provider: string, environment: NodeJS.ProcessEnv): string | undefined {
  if (provider === 'anthropic') return environment['ANTHROPIC_API_KEY']
  if (provider === 'openai' || provider === 'openai-codex') return environment['OPENAI_API_KEY']
  return environment[`${provider.replaceAll('-', '_').toUpperCase()}_API_KEY`]
}
