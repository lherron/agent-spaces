import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type LoadAgentOptions,
  canonicalSkillNames,
  loadAgent,
  reloadAgentSpacesResourceLoader,
} from 'agent-harness-runtime'

import { projectResources } from './projection.js'
import type { ParityRunMode, ResourceProjection } from './types.js'

async function compilerMaterializationResidue(root: string): Promise<string[]> {
  const found: string[] = []
  async function visit(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
      const child = join(path, entry.name)
      if (
        entry.name === 'bundle.json' ||
        entry.name === '.asp-materialized.json' ||
        (entry.isDirectory() && entry.name === 'codex.home')
      )
        found.push(child)
      if (entry.isDirectory()) await visit(child)
    }
  }
  await visit(root)
  return found.sort()
}

/**
 * Observe the actual reloaded production loader. This intentionally shares
 * only the session factory's loader seam, never compiler materialization.
 */
export async function observeDirectLoader(input: {
  agentId: string
  mode: ParityRunMode
  options: LoadAgentOptions
}): Promise<ResourceProjection> {
  const agent = await loadAgent(input.options)
  const cwd = agent.placement.cwd ?? agent.placement.projectRoot ?? agent.placement.agentRoot
  const loader = await reloadAgentSpacesResourceLoader({ cwd, agent })
  const inspection = loader.getResourceInspection()
  if (inspection.reloadCount !== 1)
    throw new Error(`Direct loader must be reloaded exactly once; got ${inspection.reloadCount}`)
  if (inspection.skillRoots.some((root) => !agent.skillPaths.includes(root)))
    throw new Error('Direct loader selected a skill root not attributed to ASP source resolution')
  const residue = await compilerMaterializationResidue(agent.aspHome)
  if (residue.length > 0)
    throw new Error(`Direct loader created compiler materialization residue: ${residue.join(', ')}`)
  return projectResources({
    agentId: input.agentId,
    mode: input.mode,
    prompt: { content: inspection.prompt.prompt.content, mode: inspection.prompt.prompt.mode },
    reminder: inspection.prompt.reminder.content,
    skills: [...inspection.selectedSkills],
    skillRoots: [...inspection.skillRoots],
    orderedSkillNames: canonicalSkillNames(agent),
  })
}
