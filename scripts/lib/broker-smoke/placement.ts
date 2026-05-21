/**
 * Broker client setup and placement materialization for smoke tests.
 */
import { basename, dirname } from 'node:path'

import { resolveScopeInput } from '../../../packages/agent-scope/src/index.ts'
import type { RuntimePlacement } from '../../../packages/config/src/core/types/placement.ts'
import { resolvePlacementContext } from '../../../packages/config/src/index.ts'
import {
  buildRuntimeBundleRef,
  resolveAgentPlacementPaths,
} from '../../../packages/config/src/store/runtime-placement.ts'
import type { InvocationInput } from '../../../packages/harness-broker-protocol/src/commands.ts'
import { expandTemplate } from '../../../packages/runtime/src/index.ts'

import type { ParsedArgs } from './types.ts'

// ---------------------------------------------------------------------------
// Placement construction
// ---------------------------------------------------------------------------

export function buildPlacement(args: ParsedArgs): RuntimePlacement {
  const { parsed, scopeRef } = resolveScopeInput(args.scopeRef)

  const paths = resolveAgentPlacementPaths({
    agentId: parsed.agentId,
    projectId: parsed.projectId,
    agentRoot: args.agentRoot,
    projectRoot: args.projectRoot,
    cwd: args.cwd,
    aspHome: args.aspHome,
  })

  if (!paths.agentRoot) {
    throw new Error(
      `Could not resolve agentRoot for "${args.scopeRef}". Provide --agent-root or ensure ASP_AGENTS_ROOT is set.`
    )
  }

  const bundle = buildRuntimeBundleRef({
    agentName: parsed.agentId,
    agentRoot: paths.agentRoot,
    projectRoot: paths.projectRoot,
  })

  return {
    agentRoot: paths.agentRoot,
    projectRoot: paths.projectRoot,
    cwd: args.cwd ?? paths.cwd,
    runMode: 'task',
    bundle,
    correlation: {
      sessionRef: { scopeRef, laneRef: 'main' },
      hostSessionId: `smoke-host-${args.invocationId}`,
    },
  }
}

// ---------------------------------------------------------------------------
// Priming prompt expansion
// ---------------------------------------------------------------------------

function buildPromptExpansionContext(placement: RuntimePlacement): {
  agentRoot: string
  agentsRoot: string
  projectRoot?: string | undefined
  projectId?: string | undefined
  agentId?: string | undefined
  agentName?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
  runMode: string
} {
  const sessionRef = placement.correlation?.sessionRef
  const parsed = sessionRef?.scopeRef ? resolveScopeInput(sessionRef.scopeRef).parsed : undefined
  const lane =
    sessionRef?.laneRef === undefined
      ? undefined
      : sessionRef.laneRef === 'main'
        ? 'main'
        : sessionRef.laneRef.slice(5)
  const agentId = parsed?.agentId ?? basename(placement.agentRoot)
  return {
    agentRoot: placement.agentRoot,
    agentsRoot: dirname(placement.agentRoot),
    agentId,
    agentName: agentId,
    projectId: parsed?.projectId,
    taskId: parsed?.taskId,
    lane,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    runMode: placement.runMode,
  }
}

export async function expectedExpandedPrimingPrompt(
  placement: RuntimePlacement
): Promise<string | undefined> {
  const placementContext = await resolvePlacementContext({ ...placement, dryRun: true })
  const primingPrompt = placementContext.materialization.effectiveConfig?.priming_prompt
  return primingPrompt === undefined
    ? undefined
    : expandTemplate(primingPrompt, buildPromptExpansionContext(placement))
}

export function assertInitialInputStartsWithPriming(
  initialInput: InvocationInput | undefined,
  expectedPriming: string | undefined
): void {
  if (expectedPriming === undefined) {
    console.log('[smoke]   No priming prompt found in effective config; skipping prefix assertion.')
    return
  }
  const firstContent = initialInput?.content[0]
  if (firstContent?.type !== 'text') {
    throw new Error('Expected initialInput.content[0] to be text with expanded priming prompt')
  }
  if (!firstContent.text.startsWith(expectedPriming)) {
    throw new Error('initialInput.content[0].text does not start with expanded priming prompt')
  }
  console.log('[smoke]   Verified: initialInput starts with expanded priming prompt.')
}
