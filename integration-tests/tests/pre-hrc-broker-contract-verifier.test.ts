import { afterEach, describe, expect, test } from 'bun:test'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function startRequest(options: Parameters<typeof compileV2>[1]) {
  const fixture = createV2CompileFixture()
  fixtures.push(fixture)
  const response = await compileV2(fixture, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan.execution.dispatchRequest.startRequest
}

describe('pre-HRC broker contract verifier on v2 execution', () => {
  test.each([
    ['codex', 'openai-codex', 'gpt-5.6-terra', false],
    ['codex', 'openai-codex', 'gpt-5.6-terra', true],
    ['claude', 'anthropic', 'claude-sonnet-4-5', true],
    ['muse', 'meta', 'muse-spark-1.3-contributor', false],
    ['muse', 'meta', 'muse-spark-1.3-contributor', true],
  ] as const)(
    'validates the %s presentation=%s canonical start request',
    async (harness, modelProvider, model, presentation) => {
      const request = await startRequest({
        namespace: `contract-${harness}-${presentation}`,
        harness,
        modelProvider,
        model,
        presentation,
        prompt: 'validate the direct dispatch contract',
      })
      expect(validateInvocationStartRequest(request)).toEqual(request)
    }
  )

  test('rejects a start request whose driver no longer agrees with its harness identity', async () => {
    const request = await startRequest({
      namespace: 'contract-mismatch',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    const invalid = {
      ...request,
      spec: {
        ...request.spec,
        driver: { ...request.spec.driver, kind: 'claude-code-tmux' },
      },
    }
    expect(() => validateInvocationStartRequest(invalid)).toThrow()
  })

  test('keeps request hash and invocation identity on the same verified payload', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'contract-hash',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'verify identity and hash',
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const request = response.plan.execution.dispatchRequest.startRequest
    expect(response.plan.execution.profile.startRequestHash).toMatch(/^[a-f0-9]{64}$/)
    expect(request.spec.invocationId).toBe(response.plan.identity.invocationId)
    expect(request.initialInput?.inputId).toBe(response.plan.identity.initialInputId)
  })

  test('rejects a broker response where a verified start request is required', () => {
    expect(() =>
      validateInvocationStartRequest({ invocationId: 'inv_wrong', state: 'running' })
    ).toThrow()
  })
})
