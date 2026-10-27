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

function expectIssue(value: unknown, path: string, code: string) {
  let error: unknown
  try {
    validateInvocationStartRequest(value)
  } catch (caught) {
    error = caught
  }
  expect(error).toMatchObject({
    issues: expect.arrayContaining([expect.objectContaining({ path, code })]),
  })
}

describe('pre-HRC broker contract verifier on v2 execution', () => {
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
    expectIssue(invalid, 'spec.harness.driver', 'invalid_driver')
  })

  test('rejects a broker response where a verified start request is required', () => {
    expect(() =>
      validateInvocationStartRequest({ invocationId: 'inv_wrong', state: 'running' })
    ).toThrow()
  })

  test('rejects stale runtime and lifecycle overlays placed on the canonical start request', async () => {
    const request = await startRequest({
      namespace: 'contract-stale-overlay',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    expectIssue(
      { ...request, runtime: { socketPath: '/tmp/not-a-start-request-field' } },
      'runtime',
      'stale_runtime_overlay'
    )
    expectIssue(
      { ...request, lifecyclePolicy: { policyId: 'not-a-start-request-field' } },
      'lifecyclePolicy',
      'stale_lifecycle_overlay'
    )
  })

  test('rejects malformed typed initial input before a broker can start it', async () => {
    const request = await startRequest({
      namespace: 'contract-invalid-input',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'validate input shape',
    })
    expectIssue(
      { ...request, initialInput: { ...request.initialInput, kind: 'invalid-input-kind' } },
      'initialInput.kind',
      'invalid_literal'
    )
  })
})
