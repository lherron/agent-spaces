import { expect, test } from 'bun:test'
import type { BashOperations } from '@earendil-works/pi-coding-agent'

import { createAgentHarnessBashToolDefinition } from './runtime-factory'

test('routes the bash tool through host-supplied operations', async () => {
  const calls: string[] = []
  const operations: BashOperations = {
    async exec(command) {
      calls.push(command)
      return { exitCode: 0 }
    },
  }
  const tool = createAgentHarnessBashToolDefinition('/repo', {}, operations)
  await tool.execute(
    'call-1',
    { command: 'git status --short' } as never,
    undefined,
    undefined,
    {} as never
  )
  expect(calls).toEqual(['git status --short'])
})
