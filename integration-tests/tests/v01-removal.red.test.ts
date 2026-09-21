import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v1 broker-profile removal', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('emits only the v2 plan and v0.2 execution protocol', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'v01-removal',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.schemaVersion).toBe('agent-runtime-compile-response/v2')
    expect(response.plan.execution.protocol).toBe('harness-broker/0.2')
  })
})
