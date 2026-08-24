import { dirname, join } from 'node:path'

import { parseScopeRef } from 'agent-scope'
import {
  type MaterializedAgentRuntimeResources,
  type RunMode,
  type RuntimePlacement,
  composeAgentRuntimeEnv,
  getAspHome,
  materializeAgentRuntimeResources,
  resolveAgentPlacementPaths,
  resolvePlacementContext,
} from 'spaces-config'
import { detectAgentLocalComponents, prepareAgentToolRuntime } from 'spaces-execution'
import { piSdkAdapter } from 'spaces-harness-pi-sdk/adapter'
import {
  type AgentSession,
  type ExtensionFactory,
  type PiAgentSessionAuth,
  type ToolDefinition,
  createPiAgentSession,
  resolvePiAgentSessionAuth,
} from 'spaces-harness-pi-sdk/agent-session'
import { type ContextResolverContext, inspectAgentSystemPrompt } from 'spaces-runtime'
import { type PiSdkModelCatalogEntry, findPiSdkModelCatalogEntry } from 'spaces-runtime-contracts'

export interface LoadAgentOptions {
  agentId: string
  projectId?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  aspHome?: string | undefined
  runMode?: RunMode | undefined
  scopeRef?: string | undefined
  laneRef?: string | undefined
  runId?: string | undefined
  hostSessionId?: string | undefined
  generation?: number | undefined
  model?: string | undefined
  provider?: 'openai' | 'anthropic' | undefined
  reasoningEffort?: string | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  /** Fully pinned context resolution inputs for deterministic callers. */
  resolverContext?: ContextResolverContext | undefined
}

export interface ResolvedAgent {
  agentId: string
  projectId?: string | undefined
  aspHome: string
  placement: RuntimePlacement
  model: PiSdkModelCatalogEntry
  reasoningEffort?: string | undefined
  environment: NodeJS.ProcessEnv
  prompt?: { content: string; mode: 'append' | 'replace' } | undefined
  reminder?: string | undefined
  skillPaths: string[]
  resources: MaterializedAgentRuntimeResources
  warnings: string[]
}

export interface CreateSessionOptions {
  agentDir?: string | undefined
  authStorePath?: string | undefined
  continuationKey?: string | undefined
  extensionFactories?: ExtensionFactory[] | undefined
  customTools?: ToolDefinition[] | undefined
  auth?: PiAgentSessionAuth | undefined
}

export async function loadAgent(options: LoadAgentOptions): Promise<ResolvedAgent> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = resolveAgentPlacementPaths({
    agentId: options.agentId,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    aspHome,
    env: process.env,
  })
  if (paths.agentRoot === undefined) {
    const searched = paths.searchedAgentRoots?.join(', ') ?? '(no configured agent roots)'
    throw new Error(`Agent ${options.agentId} was not found; searched: ${searched}`)
  }

  const projectRoot = paths.projectRoot
  const cwd = options.cwd ?? paths.cwd ?? projectRoot ?? paths.agentRoot
  const placement: RuntimePlacement = {
    agentRoot: paths.agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd,
    runMode: options.runMode ?? 'task',
    bundle: {
      kind: 'agent-project',
      agentName: options.agentId,
      ...(projectRoot !== undefined ? { projectRoot } : {}),
    },
    ...(options.scopeRef !== undefined ||
    options.runId !== undefined ||
    options.hostSessionId !== undefined ||
    options.generation !== undefined
      ? {
          correlation: {
            ...(options.scopeRef !== undefined
              ? { sessionRef: { scopeRef: options.scopeRef, laneRef: options.laneRef ?? 'main' } }
              : {}),
            ...(options.runId !== undefined ? { runId: options.runId } : {}),
            ...(options.hostSessionId !== undefined
              ? { hostSessionId: options.hostSessionId }
              : {}),
            ...(options.generation !== undefined ? { generation: options.generation } : {}),
          },
        }
      : {}),
  }
  const placementContext = await resolvePlacementContext(placement)
  const localComponents = await detectAgentLocalComponents(paths.agentRoot)
  const composedEnv = await composeAgentRuntimeEnv(
    {
      placement,
      agentLocalComponents: localComponents,
      aspHome,
      reqLockedEnv: options.lockedEnv,
      reqDispatchEnv: options.dispatchEnv,
    },
    { prepareAgentToolRuntime }
  )
  const resources = await materializeAgentRuntimeResources(placementContext.materialization.spec, {
    aspHome,
    adapter: piSdkAdapter,
    agentRoot: paths.agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    agentLocalComponents: localComponents,
    materializationTargetName: `${options.agentId}-agent-harness`,
    ...(options.projectId !== undefined
      ? {
          materializationIdentity: {
            agentId: options.agentId,
            projectId: options.projectId,
            frontend: 'agent-harness',
          },
        }
      : {}),
  })
  const promptScope = derivePromptScope(placement)
  const inspectedPrompt = await inspectAgentSystemPrompt({
    agentRoot: paths.agentRoot,
    aspHome,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...((promptScope.projectId ?? options.projectId)
      ? { projectId: promptScope.projectId ?? options.projectId }
      : {}),
    agentId: promptScope.agentId ?? options.agentId,
    ...(promptScope.taskId !== undefined ? { taskId: promptScope.taskId } : {}),
    ...(promptScope.lane !== undefined ? { lane: promptScope.lane } : {}),
    runMode: placement.runMode,
    env: composedEnv.env,
    ...(options.resolverContext !== undefined ? { resolverContext: options.resolverContext } : {}),
  })
  const requestedModel =
    options.model ?? placementContext.materialization.effectiveConfig?.model ?? 'gpt-5.6-sol'
  const model = resolveAgentHarnessModel(options.provider, requestedModel)
  const reasoningEffort =
    options.reasoningEffort ?? placementContext.materialization.effectiveConfig?.reasoning
  const localSkillPath = localComponents?.hasSkills ? localComponents.skillsDir : undefined
  const skillPaths = [
    ...(localSkillPath !== undefined ? [localSkillPath] : []),
    ...resources.skills.map((skill) => dirname(skill.sourcePath)),
  ]

  return {
    agentId: options.agentId,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    aspHome,
    placement,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    environment: { ...process.env, ...composedEnv.env },
    ...(inspectedPrompt !== undefined
      ? {
          prompt: {
            content: inspectedPrompt.prompt.content,
            mode: inspectedPrompt.prompt.mode,
          },
          ...(inspectedPrompt.reminder.content !== undefined
            ? { reminder: inspectedPrompt.reminder.content }
            : {}),
        }
      : {}),
    skillPaths,
    resources,
    warnings: [...(paths.warnings ?? []), ...composedEnv.warnings],
  }
}

function derivePromptScope(placement: RuntimePlacement): {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
} {
  const scopeRef = placement.correlation?.sessionRef?.scopeRef
  const laneRef = placement.correlation?.sessionRef?.laneRef
  if (scopeRef === undefined) {
    return laneRef === undefined
      ? {}
      : { lane: laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef }
  }
  try {
    const parsed = parseScopeRef(scopeRef)
    return {
      agentId: parsed.agentId,
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
      ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
      ...(laneRef !== undefined
        ? { lane: laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef }
        : {}),
    }
  } catch {
    const atIndex = scopeRef.indexOf('@')
    const agentId = atIndex === -1 ? scopeRef : scopeRef.slice(0, atIndex)
    const rest = atIndex === -1 ? '' : scopeRef.slice(atIndex + 1)
    const colonIndex = rest.indexOf(':')
    return {
      ...(agentId.length > 0 ? { agentId } : {}),
      ...(atIndex !== -1 && colonIndex === -1 ? { projectId: rest } : {}),
      ...(colonIndex !== -1 ? { projectId: rest.slice(0, colonIndex) } : {}),
      ...(colonIndex !== -1 ? { taskId: rest.slice(colonIndex + 1) } : {}),
      ...(laneRef !== undefined
        ? { lane: laneRef.startsWith('lane:') ? laneRef.slice('lane:'.length) : laneRef }
        : {}),
    }
  }
}

export async function createSession(
  agent: ResolvedAgent,
  options: CreateSessionOptions = {}
): Promise<AgentSession> {
  const agentDir = options.agentDir ?? join(agent.aspHome, 'agent-harness', agent.agentId)
  const auth =
    options.auth ??
    (await resolvePiAgentSessionAuth({
      authMode: agent.model.authMode,
      providerId: agent.model.piProvider,
      agentDir,
      authStorePath: options.authStorePath ?? agent.environment['HARNESS_PI_AUTH_STORE'],
    }))
  return createPiAgentSession({
    cwd: agent.placement.cwd ?? agent.placement.projectRoot ?? agent.placement.agentRoot,
    agentDir,
    model: {
      provider: agent.model.piProvider,
      modelId: agent.model.piModelId,
      ...(agent.reasoningEffort !== undefined ? { thinkingLevel: agent.reasoningEffort } : {}),
    },
    auth,
    environment: agent.environment,
    ...(agent.prompt !== undefined ? { systemPrompt: agent.prompt } : {}),
    ...(agent.reminder !== undefined ? { appendSystemPrompt: [agent.reminder] } : {}),
    skillPaths: agent.skillPaths,
    ...(options.extensionFactories !== undefined
      ? { extensionFactories: options.extensionFactories }
      : {}),
    ...(options.customTools !== undefined ? { customTools: options.customTools } : {}),
    ...(options.continuationKey !== undefined ? { continuationKey: options.continuationKey } : {}),
  })
}

export function resolveAgentHarnessModel(
  explicitProvider: LoadAgentOptions['provider'],
  requestedModel: string
): PiSdkModelCatalogEntry {
  const qualified = requestedModel.includes('/')
    ? requestedModel
    : requestedModel.startsWith('claude-')
      ? `anthropic-max/${requestedModel}`
      : `openai-codex/${requestedModel}`
  const provider = explicitProvider ?? (qualified.startsWith('anthropic') ? 'anthropic' : 'openai')
  const model = findPiSdkModelCatalogEntry(provider, qualified)
  if (model === undefined) {
    throw new Error(`Unsupported direct-harness model: ${qualified}`)
  }
  return model
}
