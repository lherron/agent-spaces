import { join } from 'node:path'

import { loadSkills } from '@earendil-works/pi-coding-agent'
import { canonicalSkillNames, loadAgent } from 'agent-harness-runtime'
import type { AgentSpacesRuntimeDependencies } from '../../../compiler/agent-spaces/src/placement-api.js'
import {
  type PreparePlacementCliRuntimeRequest,
  preparePlacementCliRuntime,
} from '../../../compiler/agent-spaces/src/prepare-cli-runtime.js'

import { projectResources } from './projection.js'
import type { ParityRunMode, ResourceProjection } from './types.js'

/** Observe the compiler seam; it deliberately does not call prompt inspection directly. */
export async function observeCompiler(input: {
  agentId: string
  mode: ParityRunMode
  request: PreparePlacementCliRuntimeRequest
  aspHome: string
  runtime: AgentSpacesRuntimeDependencies
}): Promise<ResourceProjection> {
  // Placement is optional on the request type but mandatory for this observer:
  // the parity projection is defined against a placement's agent/project roots.
  const placement = input.request.placement
  if (placement === undefined) {
    throw new Error('observeCompiler requires a placement on the compile request')
  }
  const prepared = await preparePlacementCliRuntime(
    input.request,
    input.aspHome,
    undefined,
    input.runtime
  )
  const skillRoot = join(prepared.materialized.materialization.outputPath, 'codex.home', 'skills')
  const { skills } = loadSkills({
    cwd: prepared.cwd,
    agentDir: prepared.materialized.materialization.outputPath,
    skillPaths: [skillRoot],
    includeDefaults: false,
  })
  if (prepared.systemPrompt === undefined)
    throw new Error('Compiler did not materialize a system prompt')
  const sourceAgent = await loadAgent({
    agentId: input.agentId,
    agentRoot: placement.agentRoot,
    ...(placement.projectRoot !== undefined ? { projectRoot: placement.projectRoot } : {}),
    cwd: prepared.cwd,
    aspHome: input.aspHome,
    runMode: input.mode,
    ...(placement.correlation?.sessionRef?.scopeRef !== undefined
      ? { scopeRef: placement.correlation.sessionRef.scopeRef }
      : {}),
    ...(placement.correlation?.sessionRef?.laneRef !== undefined
      ? { laneRef: placement.correlation.sessionRef.laneRef }
      : {}),
    ...(input.request.model !== undefined ? { model: input.request.model } : {}),
    ...(input.request.provider === 'openai' || input.request.provider === 'anthropic'
      ? { provider: input.request.provider }
      : {}),
    ...(input.request.resolverContext !== undefined
      ? { resolverContext: input.request.resolverContext }
      : {}),
  })
  return await projectResources({
    agentId: input.agentId,
    mode: input.mode,
    prompt: { mode: prepared.systemPrompt.mode, content: prepared.systemPrompt.content },
    reminder: prepared.systemPrompt.reminderContent,
    skills,
    skillRoots: [skillRoot],
    orderedSkillNames: canonicalSkillNames(sourceAgent),
  })
}
