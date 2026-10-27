import { describe, expect, test } from 'bun:test'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ResolvedAgent } from 'agent-harness-runtime'

import { AGENT_SCOPE_STATUS_KEY, createAgentScopeStatusExtension } from './scope-status'

function agent(
  environment: NodeJS.ProcessEnv,
  fallbacks?: { agentId?: string; projectId?: string }
) {
  return {
    agentId: fallbacks?.agentId ?? 'fallback-agent',
    ...(fallbacks?.projectId !== undefined ? { projectId: fallbacks.projectId } : {}),
    environment,
  } as ResolvedAgent
}

describe('agent-harness Pi scope status', () => {
  test.each([
    {
      environment: { AGENT_ID: 'cody', AGENT_PROJECT: 'agent-spaces', AGENT_TASK: 'T-07761' },
      expected: 'cody@agent-spaces:T-07761',
    },
    {
      environment: { AGENT_ID: 'cody', AGENT_PROJECT: 'agent-spaces' },
      expected: 'cody@agent-spaces',
    },
    { environment: { AGENT_ID: 'cody' }, expected: 'cody' },
    {
      environment: {},
      fallbacks: { agentId: 'sparky', projectId: 'hrc-runtime' },
      expected: 'sparky@hrc-runtime',
    },
  ])(
    'session start adds the $expected scope to the Pi footer',
    async ({ environment, fallbacks, expected }) => {
      let sessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined
      const extension = createAgentScopeStatusExtension(agent(environment, fallbacks))
      extension({
        on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) {
          if (event === 'session_start') sessionStart = handler
        },
      } as never)

      const statuses: Array<[string, string | undefined]> = []
      const ctx = {
        ui: {
          theme: { fg: (_tone: string, text: string) => `<dim>${text}</dim>` },
          setStatus: (key: string, text: string | undefined) => statuses.push([key, text]),
        },
      } as unknown as ExtensionContext

      expect(sessionStart).toBeDefined()
      await sessionStart?.({ type: 'session_start' }, ctx)
      expect(statuses).toEqual([[AGENT_SCOPE_STATUS_KEY, `<dim>${expected}</dim>`]])
    }
  )
})
