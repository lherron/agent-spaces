import { afterEach, describe, expect, test } from 'bun:test'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('pre-HRC broker contract verifier on v2 execution', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('validates the canonical start request without a selected-profile bridge', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'prehrc-contract-verifier',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'verify this broker contract',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    const { execution } = response.plan
    expect(() =>
      validateInvocationStartRequest(execution.dispatchRequest.startRequest)
    ).not.toThrow()
    expect(execution.profile.startRequestHash).toEqual(expect.any(String))
    expect(execution.dispatchRequest.startRequest.spec.driver.kind).toBe(execution.driver)
  })
})
