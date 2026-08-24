import { join } from 'node:path'

import { loadSkills } from '@earendil-works/pi-coding-agent'
import {
  type AgentSpacesRuntimeDependencies,
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
  return await projectResources({
    agentId: input.agentId,
    mode: input.mode,
    prompt: { mode: prepared.systemPrompt.mode, content: prepared.systemPrompt.content },
    reminder: prepared.systemPrompt.reminderContent,
    skills,
    skillRoots: [skillRoot],
  })
}
