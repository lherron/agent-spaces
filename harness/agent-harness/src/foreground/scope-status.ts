import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import type { ResolvedAgent } from 'agent-harness-runtime'

export const AGENT_SCOPE_STATUS_KEY = 'praesidium-scope'

/** Render canonical scope fields in the compact handle form used by Praesidium. */
export function formatAgentScopeStatus(agent: ResolvedAgent): string {
  const agentId = nonEmpty(agent.environment['AGENT_ID']) ?? agent.agentId
  const projectId = nonEmpty(agent.environment['AGENT_PROJECT']) ?? agent.projectId
  const taskId = nonEmpty(agent.environment['AGENT_TASK'])

  return `${agentId}${projectId !== undefined ? `@${projectId}` : ''}${
    taskId !== undefined ? `:${taskId}` : ''
  }`
}

/** Add ScopeRef identity to Pi's stock footer without replacing its metrics and model rows. */
export function createAgentScopeStatusExtension(agent: ResolvedAgent): ExtensionFactory {
  const status = formatAgentScopeStatus(agent)

  return (pi) => {
    pi.on('session_start', (_event, ctx) => {
      ctx.ui.setStatus(AGENT_SCOPE_STATUS_KEY, ctx.ui.theme.fg('dim', status))
    })
  }
}

function nonEmpty(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined
}
