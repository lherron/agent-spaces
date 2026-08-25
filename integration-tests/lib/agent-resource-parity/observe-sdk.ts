import { AgentSpacesResourceLoader, type LoadAgentOptions, loadAgent } from 'agent-harness-runtime'

import { projectResources } from './projection.js'
import type { ParityRunMode, ResourceProjection } from './types.js'

/** Observe the production direct loader, never a compiler-produced Pi bundle. */
export async function observeSdk(input: {
  agentId: string
  mode: ParityRunMode
  options: LoadAgentOptions
}): Promise<ResourceProjection> {
  const agent = await loadAgent(input.options)
  const loader = new AgentSpacesResourceLoader({
    cwd: agent.placement.cwd ?? agent.placement.projectRoot ?? agent.placement.agentRoot,
    agent,
  })
  await loader.reload()
  const { skills } = loader.getSkills()
  const inspection = loader.getInspection()
  return await projectResources({
    agentId: input.agentId,
    mode: input.mode,
    prompt: { content: inspection.prompt.content, mode: inspection.prompt.mode },
    reminder: inspection.reminder.content,
    skills,
    skillRoots: agent.skillPaths,
  })
}
