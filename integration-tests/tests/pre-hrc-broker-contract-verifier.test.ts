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

  test.each([
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', false, 'agent-harness'],
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', true, 'agent-harness-tmux'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', false, 'claude-code-tmux'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', true, 'codex-app-server'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', false, 'muse-serve'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', true, 'muse-cli-tmux'],
  ] as const)(
    'keeps the %s retained route verifiable as its expected broker driver',
    async (harness, modelProvider, model, presentation, driver) => {
      const request = await startRequest({
        namespace: `contract-driver-${harness}-${presentation}`,
        harness,
        modelProvider,
        model,
        presentation,
      })
      expect(request.spec.driver.kind).toBe(driver)
      expect(validateInvocationStartRequest(request)).toBe(request)
    }
  )

  test('rejects stale runtime and lifecycle overlays placed on the canonical start request', async () => {
    const request = await startRequest({
      namespace: 'contract-stale-overlay',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    expect(() =>
      validateInvocationStartRequest({
        ...request,
        runtime: { socketPath: '/tmp/not-a-start-request-field' },
      })
    ).toThrow()
    expect(() =>
      validateInvocationStartRequest({
        ...request,
        lifecyclePolicy: { policyId: 'not-a-start-request-field' },
      })
    ).toThrow()
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
    expect(() =>
      validateInvocationStartRequest({
        ...request,
        initialInput: {
          ...request.initialInput,
          kind: 'invalid-input-kind',
        },
      })
    ).toThrow()
  })

  test('keeps dispatch-only environment out of the hash-covered request verified by the broker', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'contract-dispatch-env',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { LOCKED_MODE: 'strict' },
      dispatchEnv: { EPHEMERAL_TOKEN: 'dispatch-only' },
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const dispatch = response.plan.execution.dispatchRequest
    expect(dispatch.dispatchEnv).toEqual({ EPHEMERAL_TOKEN: 'dispatch-only' })
    expect(JSON.stringify(dispatch.startRequest)).not.toContain('dispatch-only')
    expect(validateInvocationStartRequest(dispatch.startRequest)).toBe(dispatch.startRequest)
  })

  test('keeps the compiled initial input bound to its allocated input and invocation identity', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'contract-input-identity',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'bind input to invocation',
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    const { identity, execution } = response.plan
    expect(execution.dispatchRequest.startRequest).toMatchObject({
      initialInput: { inputId: identity.initialInputId },
      spec: { invocationId: identity.invocationId },
    })
    expect(execution.dispatchRequest.startRequest.spec.correlation).toMatchObject({
      runtimeId: identity.runtimeId,
      hostSessionId: identity.hostSessionId,
    })
  })
})
