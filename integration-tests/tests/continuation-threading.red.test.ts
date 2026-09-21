import { afterEach, describe, expect, test } from 'bun:test'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v2 continuation threading', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('threads the continuation key into the singular dispatch start request', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'continuation-threading',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'resume this thread',
      continuation: {
        schemaVersion: 'runtime-continuation/v1',
        hrc: {
          provider: 'openai',
          continuationId: 'continuation_T04829',
          key: 'thread_T04829_noloss',
        },
        broker: {
          provider: 'codex',
          kind: 'thread',
          continuationId: 'continuation_T04829',
          key: 'thread_T04829_noloss',
        },
        source: 'harness-broker',
        observedAt: '2026-09-21T00:00:00.000Z',
      },
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.execution.dispatchRequest.startRequest.spec.continuation).toMatchObject({
      key: 'thread_T04829_noloss',
    })
  })
})
