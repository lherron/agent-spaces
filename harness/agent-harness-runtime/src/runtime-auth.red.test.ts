import { expect, test } from 'bun:test'

import { createAgentHarnessRuntime } from './runtime-factory'
import type { ResolvedAgent } from './types'

/** T-07552 guard: foreground fallback must not make the shared runtime permissive. */
test('OAuth runtime remains fail-closed without an explicit auth-store path', async () => {
  const agent = {
    agentId: 'smokey',
    aspHome: '/tmp/asp-t07552',
    placement: {
      agentRoot: '/agents/smokey',
      cwd: '/repo',
      runMode: 'task',
      bundle: { kind: 'agent-project', agentName: 'smokey' },
    },
    model: {
      authMode: 'oauth',
      piProvider: 'openai-codex',
      piModelId: 'openai-codex/gpt-5.6-sol',
    },
    environment: {},
  } as unknown as ResolvedAgent

  await expect(createAgentHarnessRuntime({ agent })).rejects.toThrow(
    'OAuth mode requires an explicit Pi auth store path'
  )
})
