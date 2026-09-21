import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

const codexContinuation = {
  schemaVersion: 'runtime-continuation/v1' as const,
  hrc: {
    provider: 'openai' as const,
    continuationId: 'continuation_T08704',
    key: 'thread_T08704',
  },
  broker: {
    provider: 'codex' as const,
    kind: 'thread' as const,
    continuationId: 'continuation_T08704',
    key: 'thread_T08704',
  },
  source: 'harness-broker' as const,
  observedAt: '2026-09-21T00:00:00.000Z',
}

async function compile(options: Parameters<typeof compileV2>[1]) {
  const fixture = createV2CompileFixture()
  fixtures.push(fixture)
  const response = await compileV2(fixture, options)
  expect(response.ok).toBe(true)
  if (!response.ok) throw new Error(JSON.stringify(response.diagnostics))
  return response.plan
}

describe('v2 continuation threading', () => {
  test('threads the continuation key into the canonical start request', async () => {
    const plan = await compile({
      namespace: 'continuation-codex',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      continuation: codexContinuation,
      prompt: 'resume the durable thread',
    })
    expect(plan.execution.dispatchRequest.startRequest.spec.continuation).toMatchObject({
      provider: 'codex',
      kind: 'thread',
      key: 'thread_T08704',
    })
  })

  test('does not manufacture a continuation for a fresh compile', async () => {
    const plan = await compile({
      namespace: 'continuation-fresh',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'start a fresh thread',
    })
    expect(plan.execution.dispatchRequest.startRequest.spec.continuation).toBeUndefined()
  })

  test('uses the Anthropic session continuation for the retained Claude route', async () => {
    const plan = await compile({
      namespace: 'continuation-claude',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      continuation: {
        schemaVersion: 'runtime-continuation/v1',
        hrc: { provider: 'anthropic', continuationId: 'session_T08704', key: 'session_T08704' },
        broker: {
          provider: 'anthropic',
          kind: 'session',
          continuationId: 'session_T08704',
          key: 'session_T08704',
        },
        source: 'harness-broker',
        observedAt: '2026-09-21T00:00:00.000Z',
      },
    })
    const spec = plan.execution.dispatchRequest.startRequest.spec
    expect(spec.continuation).toMatchObject({
      provider: 'anthropic',
      kind: 'session',
      key: 'session_T08704',
    })
    expect(spec.process.args).toEqual(expect.arrayContaining(['--resume', 'session_T08704']))
  })

  test('changes the start-request hash when continuation mechanics change', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const common = {
      harness: 'codex' as const,
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    }
    const fresh = await compileV2(fixture, { ...common, namespace: 'continuation-hash-fresh' })
    const resumed = await compileV2(fixture, {
      ...common,
      namespace: 'continuation-hash-resume',
      continuation: codexContinuation,
    })
    expect(fresh.ok).toBe(true)
    expect(resumed.ok).toBe(true)
    if (!fresh.ok || !resumed.ok) return
    expect(resumed.plan.execution.profile.startRequestHash).not.toBe(
      fresh.plan.execution.profile.startRequestHash
    )
  })

  test('omits initial priming for a continuation when no caller prompt is supplied', async () => {
    const plan = await compile({
      namespace: 'continuation-no-input',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      continuation: codexContinuation,
      omitPriming: false,
    })
    expect(plan.execution.dispatchRequest.startRequest.initialInput).toBeUndefined()
  })
})
