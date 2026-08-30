import { describe, expect, test } from 'bun:test'
import type { ExtensionContext } from '@earendil-works/pi-coding-agent'
import type { ResolvedAgent } from 'agent-harness-runtime'

import {
  AGENT_SCOPE_STATUS_KEY,
  createAgentScopeStatusExtension,
  formatAgentScopeStatus,
} from './scope-status'

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
    [
      {
        AGENT_ID: 'cody',
        AGENT_PROJECT: 'agent-spaces',
        AGENT_TASK: 'T-07761',
      },
      'cody@agent-spaces:T-07761',
    ],
    [{ AGENT_ID: 'cody', AGENT_PROJECT: 'agent-spaces' }, 'cody@agent-spaces'],
    [{ AGENT_ID: 'cody' }, 'cody'],
  ] as const)('formats separate scope fields as a compact handle', (environment, expected) => {
    expect(formatAgentScopeStatus(agent(environment))).toBe(expected)
  })

  test('falls back to resolved agent identity when correlation fields are absent', () => {
    expect(formatAgentScopeStatus(agent({}, { agentId: 'sparky', projectId: 'hrc-runtime' }))).toBe(
      'sparky@hrc-runtime'
    )
  })

  test('adds the compact handle to Pi stock footer status entries on session start', async () => {
    let sessionStart: ((event: unknown, ctx: ExtensionContext) => unknown) | undefined
    const extension = createAgentScopeStatusExtension(
      agent({
        AGENT_ID: 'cody',
        AGENT_PROJECT: 'agent-spaces',
        AGENT_TASK: 'T-07761',
      })
    )
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
    expect(statuses).toEqual([[AGENT_SCOPE_STATUS_KEY, '<dim>cody@agent-spaces:T-07761</dim>']])
  })
})
