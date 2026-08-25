import { join } from 'node:path'

import {
  type AgentSession,
  type AgentSessionRuntime,
  type AgentSessionServices,
  type CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  SettingsManager,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createBashToolDefinition,
  readStoredCredential,
} from '@earendil-works/pi-coding-agent'

import { AgentSpacesResourceLoader } from './agent-resource-loader.js'
import { providerCredential } from './model-resolution.js'
import { createAgentSessionManager } from './session-manager.js'
import type {
  CreateAgentHarnessRuntimeOptions,
  CreateSessionOptions,
  PiAgentSessionAuth,
  ResolvedAgent,
  RuntimeBackedSession,
} from './types.js'

/**
 * Construct the reloaded direct resource boundary used for every Pi session
 * creation. Inspection callers use this same seam without needing model auth
 * or a live AgentSession.
 */
export async function reloadAgentSpacesResourceLoader(options: {
  cwd: string
  agent: ResolvedAgent
  extensionFactories?: CreateSessionOptions['extensionFactories']
}): Promise<AgentSpacesResourceLoader> {
  const resourceLoader = new AgentSpacesResourceLoader({
    cwd: options.cwd,
    agent: options.agent,
    ...(options.extensionFactories !== undefined
      ? { extensionFactories: options.extensionFactories }
      : {}),
  })
  await resourceLoader.reload()
  return resourceLoader
}

export async function createAgentHarnessRuntime(
  options: CreateAgentHarnessRuntimeOptions
): Promise<AgentSessionRuntime> {
  const initialCwd =
    options.cwd ??
    options.agent.placement.cwd ??
    options.agent.placement.projectRoot ??
    options.agent.placement.agentRoot
  const agentDir =
    options.agentDir ?? join(options.agent.aspHome, 'agent-harness', options.agent.agentId)
  const auth = await resolveAgentSessionAuth(options.agent, agentDir, options)
  const modelRuntime = await ModelRuntime.create({
    authPath: auth.authPath,
    modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false,
    allowModelNetwork: false,
  })
  const modelReference = resolvePiModelReference(
    options.agent.model.piProvider,
    options.agent.model.piModelId
  )
  if (modelReference.providerId !== auth.providerId) {
    throw new Error(
      `Resolved Pi provider ${modelReference.providerId} does not match authenticated provider ${auth.providerId}`
    )
  }
  if (auth.authMode === 'api-key') {
    const credential = providerCredential(auth.providerId, options.agent.environment)
    if (credential === undefined) {
      throw new Error(
        `API-key authentication requires a credential for provider ${auth.providerId}`
      )
    }
    await modelRuntime.setRuntimeApiKey(auth.providerId, credential)
  }
  const model = modelRuntime.getModel(modelReference.providerId, modelReference.modelId)
  if (model === undefined) {
    throw new Error(`Unknown Pi model: ${modelReference.providerId}/${modelReference.modelId}`)
  }

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    // Pi invokes this same closure for new, resume, fork, import, and cwd replacement.
    // A loader constructed outside this factory would silently retain stale ASP sources.
    const settingsManager = SettingsManager.create(cwd, runtimeAgentDir)
    const resourceLoader = await reloadAgentSpacesResourceLoader({
      cwd,
      agent: options.agent,
      ...(options.extensionFactories !== undefined
        ? { extensionFactories: options.extensionFactories }
        : {}),
    })
    const activeAgent = resourceLoader.getResolvedAgent()
    const services: AgentSessionServices = {
      cwd,
      agentDir: runtimeAgentDir,
      modelRuntime,
      settingsManager,
      resourceLoader,
      diagnostics: activeAgent.warnings.map((message) => ({ type: 'warning' as const, message })),
    }
    const bashTool = createBashToolDefinition(cwd, {
      spawnHook: (context) => ({ ...context, cwd, env: { ...activeAgent.environment } }),
      exposeSessionEnvironment: false,
    })
    const created = await createAgentSessionFromServices({
      services,
      sessionManager,
      ...(sessionStartEvent !== undefined ? { sessionStartEvent } : {}),
      model,
      ...(activeAgent.reasoningEffort !== undefined
        ? { thinkingLevel: activeAgent.reasoningEffort as never }
        : {}),
      customTools: [bashTool as never, ...(options.customTools ?? [])],
    })
    assertSessionUsesAgentSpacesResources(created.session)
    return { ...created, services, diagnostics: services.diagnostics }
  }

  return createAgentSessionRuntime(createRuntime, {
    cwd: initialCwd,
    agentDir,
    sessionManager:
      options.sessionManager ??
      createAgentSessionManager({
        aspHome: options.agent.aspHome,
        agentId: options.agent.agentId,
        cwd: initialCwd,
        continuationKey: options.continuationKey,
      }),
  })
}

/** Compatibility facade for the broker's narrow PiSdkSession shape. */
export async function createSession(
  agent: ResolvedAgent,
  options: CreateSessionOptions = {}
): Promise<RuntimeBackedSession> {
  const runtime = await createAgentHarnessRuntime({ agent, ...options })
  return attachRuntimeDisposal(runtime)
}

export function assertSessionUsesAgentSpacesResources(session: AgentSession): void {
  if (!(session.resourceLoader instanceof AgentSpacesResourceLoader)) {
    throw new Error('AgentSession is not using AgentSpacesResourceLoader')
  }
  const inspection = session.resourceLoader.getInspection()
  if (!session.systemPrompt.includes(inspection.prompt.content)) {
    throw new Error('AgentSession system prompt is missing the ASP prompt')
  }
  if (
    inspection.reminder.content !== undefined &&
    !session.systemPrompt.includes(inspection.reminder.content)
  ) {
    throw new Error('AgentSession system prompt is missing the ASP reminder')
  }
}

function attachRuntimeDisposal(runtime: AgentSessionRuntime): RuntimeBackedSession {
  const session = runtime.session as RuntimeBackedSession
  let disposal: Promise<void> | undefined
  Object.defineProperty(session, 'dispose', {
    configurable: true,
    value: () => {
      disposal ??= runtime.dispose()
      return disposal
    },
  })
  return session
}

async function resolveAgentSessionAuth(
  agent: ResolvedAgent,
  agentDir: string,
  options: CreateSessionOptions
): Promise<PiAgentSessionAuth> {
  if (options.auth !== undefined) return options.auth
  if (agent.model.authMode === 'api-key') {
    return {
      authMode: 'api-key',
      authPath: join(agentDir, 'auth.json'),
      providerId: agent.model.piProvider,
    }
  }
  const authPath = options.authStorePath ?? agent.environment['HARNESS_PI_AUTH_STORE']
  if (authPath === undefined || authPath.trim().length === 0) {
    throw new Error('OAuth mode requires an explicit Pi auth store path')
  }
  const credential = readStoredCredential(agent.model.piProvider, authPath)
  if (credential?.type !== 'oauth') {
    throw new Error(
      `OAuth auth store credential for provider ${agent.model.piProvider} is not OAuth-typed`
    )
  }
  return { authMode: 'oauth', authPath, providerId: agent.model.piProvider }
}

function resolvePiModelReference(
  provider: string,
  modelId: string
): { providerId: string; modelId: string } {
  const prefix = `${provider}/`
  return {
    providerId: provider,
    modelId: modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId,
  }
}
