import { SettingsManager } from '@earendil-works/pi-coding-agent'
import { type LoadAgentOptions, loadAgent } from 'agent-harness-sdk'
import { createPiAgentResourceLoader } from 'spaces-harness-pi-sdk/agent-session'

import { projectResources } from './projection.js'
import type { ParityRunMode, ResourceProjection } from './types.js'

/** Observe SDK resources through the exact Pi loader construction used by sessions. */
export async function observeSdk(input: {
  agentId: string
  mode: ParityRunMode
  options: LoadAgentOptions
}): Promise<ResourceProjection> {
  const agent = await loadAgent(input.options)
  const loader = createPiAgentResourceLoader(
    {
      cwd: agent.placement.cwd,
      agentDir: agent.placement.agentRoot,
      model: { provider: agent.model.piProvider, modelId: agent.model.piModelId },
      auth: { authMode: agent.model.authMode, authPath: '', providerId: agent.model.piProvider },
      environment: agent.environment,
      skillPaths: agent.skillPaths,
    },
    SettingsManager.inMemory()
  )
  await loader.reload()
  const { skills } = loader.getSkills()
  if (agent.prompt === undefined) throw new Error('SDK did not resolve a system prompt')
  return await projectResources({
    agentId: input.agentId,
    mode: input.mode,
    prompt: agent.prompt,
    reminder: agent.reminder,
    skills,
    skillRoots: agent.skillPaths,
  })
}
