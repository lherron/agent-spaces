import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v2 agent environment contract', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('keeps explicitly locked environment in the compiled execution only', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'agent-env-contract',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'inspect the environment',
      lockedEnv: { EXTRA_FLAG: '1', AGENT_SCOPE_REF: 'cody@agent-spaces' },
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    const environment = response.plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv
    expect(environment).toMatchObject({ EXTRA_FLAG: '1', AGENT_SCOPE_REF: 'cody@agent-spaces' })
    expect(response.plan.lockedEnv.lockedEnvKeys).toEqual(
      expect.arrayContaining(['AGENT_SCOPE_REF', 'EXTRA_FLAG'])
    )
    expect(response.plan.selection).not.toHaveProperty('lockedEnv')
  })
})
