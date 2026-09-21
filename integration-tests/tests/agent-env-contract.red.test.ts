import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

async function compile(options: Parameters<typeof compileV2>[1]) {
  const fixture = createV2CompileFixture()
  fixtures.push(fixture)
  const response = await compileV2(fixture, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan
}

describe('v2 agent environment contract', () => {
  test('keeps declared locks in the canonical start request and summarizes only their keys', async () => {
    const plan = await compile({
      namespace: 'env-locked',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1', SAFE_MODE: 'strict' },
    })
    expect(plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv).toMatchObject({
      EXTRA_FLAG: '1',
      SAFE_MODE: 'strict',
    })
    expect(plan.lockedEnv.lockedEnvKeys).toEqual(
      expect.arrayContaining(['EXTRA_FLAG', 'SAFE_MODE'])
    )
    expect(JSON.stringify(plan.lockedEnv)).not.toContain('strict')
  })

  test('does not synthesize host correlation into the locked environment', async () => {
    const plan = await compile({
      namespace: 'env-hygiene',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1' },
      scopeRef: 'agent:cody:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
    })
    const locked = plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv
    expect(locked).not.toHaveProperty('AGENT_SCOPE_REF')
    expect(locked).not.toHaveProperty('AGENT_LANE_REF')
    expect(locked).not.toHaveProperty('AGENT_HOST_SESSION_ID')
  })

  test('keeps ambient dispatch values outside the hash-covered start request', async () => {
    const plan = await compile({
      namespace: 'env-dispatch',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      dispatchEnv: { PATH: '/runtime/bin', RUNTIME_TOKEN: 'not-a-lock' },
    })
    expect(plan.execution.dispatchRequest.dispatchEnv).toEqual({
      PATH: '/runtime/bin',
      RUNTIME_TOKEN: 'not-a-lock',
    })
    expect(JSON.stringify(plan.execution.dispatchRequest.startRequest)).not.toContain('not-a-lock')
    expect(plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv).not.toHaveProperty(
      'RUNTIME_TOKEN'
    )
  })

  test('keeps the declared environment stable when only dispatch values change', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const common = {
      harness: 'codex' as const,
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1' },
    }
    const first = await compileV2(fixture, {
      ...common,
      namespace: 'env-dispatch-a',
      dispatchEnv: { RUNTIME_INSTANCE: 'a' },
    })
    const second = await compileV2(fixture, {
      ...common,
      namespace: 'env-dispatch-b',
      dispatchEnv: { RUNTIME_INSTANCE: 'b' },
    })
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
    if (!first.ok || !second.ok) return
    expect(second.plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv).toEqual(
      first.plan.execution.dispatchRequest.startRequest.spec.process.lockedEnv
    )
  })
})
