import { afterEach, describe, expect, test } from 'bun:test'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

import {
  buildV2CompileRequest,
  compileV2,
  compileV2Request,
  createV2CompileFixture,
} from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

function fixture(agentId = 'cody') {
  const value = createV2CompileFixture(agentId)
  fixtures.push(value)
  return value
}

async function planFor(options: Parameters<typeof compileV2>[1], agentId?: string) {
  const value = fixture(agentId)
  const response = await compileV2(value, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return { fixture: value, response, plan: response.plan }
}

describe('v2 runtime compile plan', () => {
  test.each([
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', false, 'agent-harness'],
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', true, 'agent-harness-tmux'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', false, 'claude-code-tmux'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', true, 'claude-code-tmux'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', false, 'codex-app-server'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', true, 'codex-app-server'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', false, 'muse-serve'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', true, 'muse-cli-tmux'],
  ] as const)(
    'resolves %s presentation=%s to its catalog execution',
    async (harness, modelProvider, model, presentation, driver) => {
      const { plan } = await planFor({
        namespace: `all-routes-${harness}-${presentation}`,
        harness,
        modelProvider,
        model,
        presentation,
        reasoningEffort: 'medium',
        prompt: 'compile one canonical execution',
      })

      expect(plan.schemaVersion).toBe('agent-runtime-plan/v2')
      expect(plan.selection).toMatchObject({ harness, modelProvider, model, presentation })
      expect(plan.execution.driver).toBe(driver)
      expect(plan.execution.dispatchRequest.startRequest.spec.driver.kind).toBe(driver)
      expect(() =>
        validateInvocationStartRequest(plan.execution.dispatchRequest.startRequest)
      ).not.toThrow()
    }
  )

  test('preserves caller identity and flat correlation in the plan and start request', async () => {
    const value = fixture('identity-agent')
    const request = buildV2CompileRequest(value, {
      namespace: 'identity-correlation',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      scopeRef: 'agent:identity-agent:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
      prompt: 'retain every identity field',
    })
    const response = await compileV2Request(value, request)
    expect(response.ok).toBe(true)
    if (!response.ok) return

    expect(response.plan.agent).toEqual(request.agent)
    expect(response.plan.identity).toEqual(request.identity)
    expect(response.plan.placement).toMatchObject({
      correlation: {
        sessionRef: {
          scopeRef: request.correlation.scopeRef,
          laneRef: request.correlation.laneRef,
        },
        hostSessionId: request.identity.hostSessionId,
      },
    })
    expect(response.plan.execution.dispatchRequest.startRequest.spec.correlation).toMatchObject({
      requestId: request.identity.requestId,
      operationId: request.identity.operationId,
      hostSessionId: request.identity.hostSessionId,
      runtimeId: request.identity.runtimeId,
      scopeRef: request.correlation.scopeRef,
      laneRef: request.correlation.laneRef,
    })
  })

  test('preserves explicit false and resolves omitted presentation from the catalog', async () => {
    const value = fixture()
    const explicit = buildV2CompileRequest(value, {
      namespace: 'presentation-explicit',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    const omitted = buildV2CompileRequest(value, {
      namespace: 'presentation-omitted',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
    })
    expect(explicit.requested.presentation).toBe(false)
    expect(omitted.requested).not.toHaveProperty('presentation')

    const response = await compileV2Request(value, omitted)
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.selection.presentation).toBe(false)
    expect(response.plan.selection.provenance.presentation).toBe('catalog-default')
  })

  test('returns an error plan-free response for an unsupported retained-harness model', async () => {
    const value = fixture()
    const response = await compileV2(value, {
      namespace: 'unsupported-model',
      harness: 'codex',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: false,
    })
    expect(response.ok).toBe(false)
    expect('plan' in response).toBe(false)
    expect(response.diagnostics).toContainEqual(
      expect.objectContaining({ level: 'error', plane: 'asp-compiler' })
    )
  })

  test('exposes one hash-covered execution and canonical start request', async () => {
    const { plan } = await planFor({
      namespace: 'execution-projection',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'single execution only',
    })

    for (const hash of [
      plan.planHash,
      plan.execution.profile.profileHash,
      plan.execution.profile.compatibilityHash,
      plan.execution.profile.startRequestHash,
    ]) {
      expect(hash).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(plan.execution.dispatchRequest.startRequest.spec.invocationId).toBe(
      plan.identity.invocationId
    )
  })

  test('keeps stable hashes for an identical request', async () => {
    const value = fixture()
    const request = buildV2CompileRequest(value, {
      namespace: 'stable-hashes',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'same mechanics',
    })
    const first = await compileV2Request(value, request)
    const second = await compileV2Request(value, request)
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.plan.planHash).toBe(first.plan.planHash)
    expect(second.plan.execution.profile).toEqual(first.plan.execution.profile)
  })

  test('changes mechanics hashes when the retained model changes', async () => {
    const value = fixture()
    const first = await compileV2(value, {
      namespace: 'model-a',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    const second = await compileV2(value, {
      namespace: 'model-b',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-sol',
      presentation: false,
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.plan.planHash).not.toBe(first.plan.planHash)
    expect(second.plan.execution.profile.startRequestHash).not.toBe(
      first.plan.execution.profile.startRequestHash
    )
    expect(second.plan.execution.profile.compatibilityHash).not.toBe(
      first.plan.execution.profile.compatibilityHash
    )
  })

  test('summarizes locked keys without leaking placement correlation into process environment', async () => {
    const { plan } = await planFor({
      namespace: 'locked-environment',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1', SAFE_KEY: '2' },
      scopeRef: 'agent:cody:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
    })
    const locked = plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv
    expect(plan.lockedEnv.lockedEnvKeys).toEqual(expect.arrayContaining(['EXTRA_FLAG', 'SAFE_KEY']))
    expect(locked).toMatchObject({ EXTRA_FLAG: '1', SAFE_KEY: '2' })
    expect(locked).not.toHaveProperty('AGENT_SCOPE_REF')
    expect(locked).not.toHaveProperty('AGENT_LANE_REF')
    expect(locked).not.toHaveProperty('AGENT_HOST_SESSION_ID')
  })

  test('carries dispatch environment only in the dispatch envelope, not its start request', async () => {
    const { plan } = await planFor({
      namespace: 'dispatch-environment',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      dispatchEnv: { AGENT_HOST_SESSION_ID: 'host-dispatch', AGENT_LANE_REF: 'repair' },
    })
    expect(plan.execution.dispatchRequest.dispatchEnv).toEqual({
      AGENT_HOST_SESSION_ID: 'host-dispatch',
      AGENT_LANE_REF: 'repair',
    })
    expect(JSON.stringify(plan.execution.dispatchRequest.startRequest)).not.toContain(
      'host-dispatch'
    )
  })

  test('materializes requested task context, prompt, attachments, and omitted priming', async () => {
    const value = fixture()
    const image = `${value.projectRoot}/diagram.png`
    const response = await compileV2(value, {
      namespace: 'materialization',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'inspect the materialized request',
      omitPriming: true,
      attachments: [{ kind: 'image', path: image, mimeType: 'image/png' }],
      taskContext: {
        taskId: 'T-08704',
        phase: 'integration',
        role: 'verification',
        requiredEvidenceKinds: ['contract-artifacts', 'live-smoke'],
        hintsText: 'v2 materialization evidence',
      },
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return

    expect(response.plan.omitPriming).toBe(true)
    expect(response.plan.execution.dispatchRequest.startRequest.initialInput?.content).toEqual(
      expect.arrayContaining([
        { type: 'text', text: 'inspect the materialized request' },
        { type: 'local_image', path: image },
      ])
    )
  })

  test('keeps foreground process preparation out of ordinary harness selection', async () => {
    const { plan } = await planFor({
      namespace: 'no-foreground-bridge',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
    })
    expect(plan.execution.driver).toBe('claude-code-tmux')
    expect(plan.execution.dispatchRequest.startRequest.spec.process.harnessTransport).toEqual({
      kind: 'pty',
    })
  })

  test('keeps the complete identity allocation attached to both the plan and its only dispatch', async () => {
    const value = fixture('allocated-agent')
    const request = buildV2CompileRequest(value, {
      namespace: 'complete-identity',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'retain the allocation',
    })
    const response = await compileV2Request(value, request)
    expect(response.ok).toBe(true)
    if (!response.ok) return

    expect(response.plan.identity).toEqual(request.identity)
    expect(response.plan.execution.dispatchRequest.startRequest.spec).toMatchObject({
      invocationId: request.identity.invocationId,
      correlation: expect.objectContaining({
        requestId: request.identity.requestId,
        operationId: request.identity.operationId,
        hostSessionId: request.identity.hostSessionId,
        runtimeId: request.identity.runtimeId,
        runId: request.identity.runId,
        traceId: request.identity.traceId,
      }),
    })
  })

  test('keeps correlation changes out of compatibility mechanics while preserving their dispatch values', async () => {
    const value = fixture()
    const common = {
      harness: 'codex' as const,
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { LOCKED_MODE: 'strict' },
    }
    const first = await compileV2(value, {
      ...common,
      namespace: 'correlation-mechanics-a',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
    })
    const second = await compileV2(value, {
      ...common,
      namespace: 'correlation-mechanics-b',
      scopeRef: 'agent:cody:project:agent-spaces:task:T-99999',
      laneRef: 'main',
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return

    expect(second.plan.execution.profile.compatibilityHash).toBe(
      first.plan.execution.profile.compatibilityHash
    )
    expect(second.plan.execution.dispatchRequest.startRequest.spec.correlation).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-99999',
      laneRef: 'main',
    })
  })

  test('retains requested reasoning effort as selection data without exposing a selectable driver', async () => {
    const { plan } = await planFor({
      namespace: 'reasoning-selection',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      reasoningEffort: 'xhigh',
    })
    expect(plan.selection).toMatchObject({
      harness: 'codex',
      reasoningEffort: 'xhigh',
      provenance: { reasoningEffort: 'compile-request' },
    })
    expect(plan.execution).not.toHaveProperty('selectedDriver')
  })

  test('keeps placement bundle and requested run mode available to the broker start request', async () => {
    const { plan } = await planFor(
      {
        namespace: 'placement-materialization',
        harness: 'muse',
        modelProvider: 'meta',
        model: 'muse-spark-1.3-contributor',
        presentation: false,
        runMode: 'heartbeat',
        prompt: 'materialize placement facts',
      },
      'placement-agent'
    )
    expect(plan.placement).toMatchObject({
      runMode: 'heartbeat',
      bundle: { kind: 'agent-project', agentName: 'placement-agent' },
    })
    expect(plan.execution.dispatchRequest.startRequest.spec.correlation).toMatchObject({
      scopeRef: 'agent:placement-agent:project:agent-spaces',
    })
  })

  test('publishes one canonical execution in a successful v2 plan', async () => {
    const { plan } = await planFor({
      namespace: 'singular-execution',
      harness: 'agent-harness',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: true,
    })
    expect(plan.execution.dispatchRequest.startRequest.spec.driver.kind).toBe(plan.execution.driver)
    expect(plan.execution.profile.profileId).toMatch(/^profile_/)
    expect(Object.keys(plan)).toEqual(
      expect.arrayContaining(['selection', 'execution', 'agent', 'identity', 'placement'])
    )
  })
})
