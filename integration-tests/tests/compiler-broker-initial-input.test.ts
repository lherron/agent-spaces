import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v2 broker initial input', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('puts an initial prompt in the only dispatch request', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'initial-input-present',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'initial input must be canonical',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    const initialInput = response.plan.execution.dispatchRequest.startRequest.initialInput
    expect(initialInput?.content).toContainEqual({
      type: 'text',
      text: 'initial input must be canonical',
    })
    expect(response.plan.execution.profile.startRequestHash).toEqual(expect.any(String))
  })

  test('does not synthesize an input when a request omits it', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'initial-input-omitted',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution.dispatchRequest.startRequest.initialInput).toBeUndefined()
  })
})
