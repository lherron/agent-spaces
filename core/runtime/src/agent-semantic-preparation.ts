import { parseScopeRef } from 'agent-scope'
import {
  type AgentLocalComponents,
  type AgentToolRuntimePreparer,
  type ResolvedAgentResourceSources,
  type RunMode,
  type RuntimePlacement,
  getAspHome,
  resolveAgentPlacementPaths,
  resolveAgentResourceSources,
} from 'spaces-config'
import {
  type PiProviderModelCatalogEntry,
  findPiProviderModelCatalogEntry,
} from 'spaces-runtime-contracts'
import { type AgentSystemPromptInspection, inspectAgentSystemPrompt } from './system-prompt.js'

/** Execution-plane hooks supplied by the composition root; this core seam never discovers a harness. */
export interface AgentSemanticPreparationRuntime extends AgentToolRuntimePreparer {
  detectAgentLocalComponents(agentRoot: string): Promise<AgentLocalComponents | undefined>
}

/** Semantic inputs shared by compiler projection and the direct first-party worker. */
export interface LoadAgentSemanticOptions {
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
  provider?: 'openai' | 'openai-codex' | 'anthropic' | 'anthropic-max' | undefined
  reasoningEffort?: string | undefined
  lockedEnv?: Record<string, string> | undefined
  dispatchEnv?: Record<string, string> | undefined
  baseEnvironment?: NodeJS.ProcessEnv | undefined
  resolverContext?: Parameters<typeof inspectAgentSystemPrompt>[0]['resolverContext'] | undefined
}

export interface ResolvedAgentSemantics {
  input: LoadAgentSemanticOptions
  agentId: string
  projectId?: string | undefined
  aspHome: string
  placement: RuntimePlacement
  model: PiProviderModelCatalogEntry
  reasoningEffort?: string | undefined
  environment: NodeJS.ProcessEnv
  prompt?: { content: string; mode: 'append' | 'replace' } | undefined
  reminder?: string | undefined
  inspection?: AgentSystemPromptInspection | undefined
  sources: ResolvedAgentResourceSources
  skillPaths: string[]
  warnings: string[]
}

/**
 * Resolve direct ASP semantics without a harness adapter, executable discovery,
 * argv construction, or generated harness bundle. Both compiler projection and
 * the first-party worker use this lower-layer seam.
 */
export async function loadAgentSemantics(
  options: LoadAgentSemanticOptions,
  runtime: AgentSemanticPreparationRuntime
): Promise<ResolvedAgentSemantics> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = resolveAgentPlacementPaths({
    agentId: options.agentId,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    ...(options.agentRoot !== undefined ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}),
    ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
    aspHome,
    env: options.baseEnvironment ?? process.env,
  })
  if (paths.agentRoot === undefined) {
    throw new Error(
      `Agent ${options.agentId} was not found; searched: ${paths.searchedAgentRoots?.join(', ') ?? '(no configured agent roots)'}`
    )
  }

  const placement = createPlacement(
    options,
    paths.agentRoot,
    paths.projectRoot,
    options.cwd ?? paths.cwd
  )
  const localComponents = await runtime.detectAgentLocalComponents(paths.agentRoot)
  const sources = await resolveAgentResourceSources({
    placement,
    aspHome,
    agentLocalComponents: localComponents,
    reqLockedEnv: options.lockedEnv,
    reqDispatchEnv: options.dispatchEnv,
    ...(options.baseEnvironment !== undefined ? { baseEnvironment: options.baseEnvironment } : {}),
    warnings: paths.warnings,
    runtime,
  })
  const promptScope = derivePromptScope(placement)
  const inspection = await inspectAgentSystemPrompt({
    agentRoot: paths.agentRoot,
    aspHome,
    ...(paths.projectRoot !== undefined ? { projectRoot: paths.projectRoot } : {}),
    ...((promptScope.projectId ?? options.projectId)
      ? { projectId: promptScope.projectId ?? options.projectId }
      : {}),
    agentId: promptScope.agentId ?? options.agentId,
    ...(promptScope.taskId !== undefined ? { taskId: promptScope.taskId } : {}),
    ...(promptScope.lane !== undefined ? { lane: promptScope.lane } : {}),
    runMode: placement.runMode,
    env: sources.environment,
    ...(options.resolverContext !== undefined ? { resolverContext: options.resolverContext } : {}),
  })
  const model = resolveAgentHarnessModel(
    options.provider,
    options.model ?? sources.effectiveConfig.model ?? 'gpt-5.6-sol'
  )
  const reasoningEffort = options.reasoningEffort ?? sources.effectiveConfig.reasoning_effort

  return {
    input: options,
    agentId: options.agentId,
    ...(options.projectId !== undefined ? { projectId: options.projectId } : {}),
    aspHome,
    placement,
    model,
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    environment: sources.environment,
    ...(inspection !== undefined
      ? {
          inspection,
          prompt: { content: inspection.prompt.content, mode: inspection.prompt.mode },
          ...(inspection.reminder.content !== undefined
            ? { reminder: inspection.reminder.content }
            : {}),
        }
      : {}),
    sources,
    skillPaths: sources.skillRoots.map((root) => root.root),
    warnings: sources.warnings,
  }
}

/** Canonical direct Pi SDK model qualification shared by compiler and worker. */
export function resolveAgentHarnessModel(
  explicitProvider: LoadAgentSemanticOptions['provider'],
  requestedModel: string
): PiProviderModelCatalogEntry {
  const provider =
    explicitProvider ?? (requestedModel.startsWith('claude-') ? 'anthropic-max' : 'openai-codex')
  const qualified = requestedModel.includes('/') ? requestedModel : `${provider}/${requestedModel}`
  const model = findPiProviderModelCatalogEntry(provider, qualified)
  if (model === undefined) throw new Error(`Unsupported direct-harness model: ${qualified}`)
  return model
}

function createPlacement(
  options: LoadAgentSemanticOptions,
  agentRoot: string,
  projectRoot: string | undefined,
  cwd: string | undefined
): RuntimePlacement {
  return {
    agentRoot,
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    cwd: cwd ?? projectRoot ?? agentRoot,
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
}

function derivePromptScope(placement: RuntimePlacement): {
  agentId?: string
  projectId?: string
  taskId?: string
  lane?: string
} {
  const scopeRef = placement.correlation?.sessionRef?.scopeRef
  const laneRef = placement.correlation?.sessionRef?.laneRef
  const lane =
    laneRef === undefined ? undefined : laneRef.startsWith('lane:') ? laneRef.slice(5) : laneRef
  if (scopeRef === undefined) return lane === undefined ? {} : { lane }
  try {
    const parsed = parseScopeRef(scopeRef)
    return {
      agentId: parsed.agentId,
      ...(parsed.projectId !== undefined ? { projectId: parsed.projectId } : {}),
      ...(parsed.taskId !== undefined ? { taskId: parsed.taskId } : {}),
      ...(lane !== undefined ? { lane } : {}),
    }
  } catch {
    const at = scopeRef.indexOf('@')
    const agentId = at === -1 ? scopeRef : scopeRef.slice(0, at)
    const [projectId, taskId] = (at === -1 ? '' : scopeRef.slice(at + 1)).split(':', 2)
    return {
      ...(agentId ? { agentId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(lane !== undefined ? { lane } : {}),
    }
  }
}
