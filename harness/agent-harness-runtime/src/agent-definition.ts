import { parseScopeRef } from 'agent-scope'
import {
  type RuntimePlacement,
  getAspHome,
  resolveAgentPlacementPaths,
  resolveAgentResourceSources,
} from 'spaces-config'
import { detectAgentLocalComponents, prepareAgentToolRuntime } from 'spaces-execution'
import { inspectAgentSystemPrompt } from 'spaces-runtime'

import { resolveAgentHarnessModel } from './model-resolution.js'
import type { LoadAgentOptions, ResolvedAgent } from './types.js'

/** Resolve ASP semantics into direct source roots; this never materializes a Pi bundle. */
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
  const localComponents = await detectAgentLocalComponents(paths.agentRoot)
  const sources = await resolveAgentResourceSources({
    placement,
    aspHome,
    agentLocalComponents: localComponents,
    reqLockedEnv: options.lockedEnv,
    reqDispatchEnv: options.dispatchEnv,
    warnings: paths.warnings,
    runtime: { prepareAgentToolRuntime },
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
  const reasoningEffort = options.reasoningEffort ?? sources.effectiveConfig.reasoning

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

function createPlacement(
  options: LoadAgentOptions,
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
