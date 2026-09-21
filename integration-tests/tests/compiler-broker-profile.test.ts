import { afterEach, describe, expect, test } from 'bun:test'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

import { compileV2, createV2CompileFixture } from './v2-compile-fixture.js'

describe('v2 broker execution projection', () => {
  const fixtures: Array<ReturnType<typeof createV2CompileFixture>> = []

  afterEach(() => {
    for (const fixture of fixtures.splice(0)) fixture.cleanup()
  })

  test('carries process, profile identity, and dispatch request together', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'broker-profile-codex',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      prompt: 'compile one canonical broker start request',
      lockedEnv: { EXTRA_FLAG: '1' },
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    const { execution } = response.plan
    expect(execution.driver).toBe('codex-app-server')
    expect(execution.protocol).toBe('harness-broker/0.2')
    expect(execution.profile).toMatchObject({
      profileId: expect.any(String),
      profileHash: expect.any(String),
      compatibilityHash: expect.any(String),
      startRequestHash: expect.any(String),
    })
    expect(execution.dispatchRequest.startRequest.spec.process.lockedEnv).toMatchObject({
      EXTRA_FLAG: '1',
    })
    expect(() =>
      validateInvocationStartRequest(execution.dispatchRequest.startRequest)
    ).not.toThrow()
  })

  test('keeps presentation a selection concern, not an input selector', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const response = await compileV2(fixture, {
      namespace: 'broker-profile-codex-presentation',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: true,
      prompt: 'compile presentation surface',
    })

    expect(response.ok).toBe(true)
    if (!response.ok) return
    expect(response.plan.selection.presentation).toBe(true)
    expect(response.plan.execution.presentationSurface).toEqual({
      transport: 'websocket-unix',
      terminalHost: 'tmux',
    })
  })
})
