import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v2 runtime compile plan', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test.each([
    ['agent-harness', 'openai', 'gpt-5.6-terra', false, 'agent-harness'],
    ['agent-harness', 'openai', 'gpt-5.6-terra', true, 'agent-harness-tmux'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', false, 'claude-code-tmux'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', true, 'claude-code-tmux'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', false, 'codex-app-server'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', true, 'codex-app-server'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', false, 'muse-serve'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', true, 'muse-cli-tmux'],
  ] as const)(
    'resolves %s presentation=%s into one %s execution',
    async (harness, modelProvider, model, presentation, driver) => {
      const fixture = createV2CompileFixture()
      fixtures.push(fixture)
      const response = await compileV2(fixture, {
        namespace: `runtime-plan-${harness}-${String(presentation)}`,
        harness,
        modelProvider,
        model,
        presentation,
        reasoningEffort: 'medium',
        prompt: 'v2 singular-plan fixture',
      })

      expect(response.ok).toBe(true)
      if (!response.ok) return
      expect(response.schemaVersion).toBe('agent-runtime-compile-response/v2')
      expect(response.plan.schemaVersion).toBe('agent-runtime-plan/v2')
      expect(response.plan.selection).toMatchObject({
        harness,
        modelProvider,
        model,
        presentation,
      })
      expect(response.plan.execution.driver).toBe(driver)
      expect(response.plan.execution.dispatchRequest.startRequest.spec.driver.kind).toBe(driver)
    }
  )

  test('preserves omitted presentation as a catalog-default decision', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'runtime-plan-omitted-presentation',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.selection.presentation).toBe(false)
    expect(response.plan.selection.provenance.presentation).toBe('catalog-default')
  })
})
