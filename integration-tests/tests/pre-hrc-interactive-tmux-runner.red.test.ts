import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('pre-HRC interactive tmux preparation', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('derives the Claude terminal requirement from presentation rather than a route selector', async () => {
    const fixture = createV2CompileFixture('smokey')
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'interactive-tmux-runner',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      prompt: 'prepare an interactive Claude session',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution).toMatchObject({
      driver: 'claude-code-tmux',
      hosting: { terminalRequired: true, terminalHost: 'tmux' },
    })
  })
})
