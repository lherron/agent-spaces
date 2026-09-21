import { afterEach, describe, expect, test } from 'bun:test'

import { buildV2CompileRequest, compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup()
})

describe('v1 broker-profile removal', () => {
  test('emits only the v2 compile response, v2 plan, and v0.2 broker protocol', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'v2-only-codex',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.schemaVersion).toBe('agent-runtime-compile-response/v2')
    expect(response.plan.schemaVersion).toBe('agent-runtime-plan/v2')
    expect(response.plan.execution.protocol).toBe('harness-broker/0.2')
  })

  test('builds a request with only v2 selection fields', () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const request = buildV2CompileRequest(fixture, {
      namespace: 'v2-request-shape',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      reasoningEffort: 'high',
    })
    expect(request.schemaVersion).toBe('agent-runtime-compile-request/v2')
    expect(request.requested).toEqual({
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      reasoningEffort: 'high',
      presentation: true,
    })
  })

  test('keeps protocol version independent from the selected retained harness', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'v2-protocol-muse',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: true,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution).toMatchObject({
      driver: 'muse-cli-tmux',
      protocol: 'harness-broker/0.2',
    })
  })
})
