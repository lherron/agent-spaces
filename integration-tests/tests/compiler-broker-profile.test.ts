import { afterEach, describe, expect, test } from 'bun:test'
import { validateInvocationStartRequest } from 'spaces-harness-broker-protocol'

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
  return response.plan.execution
}

describe('v2 broker execution projection', () => {
  test('emits a validating Codex app-server start request with one profile identity', async () => {
    const execution = await compile({
      namespace: 'profile-codex',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      lockedEnv: { EXTRA_FLAG: '1' },
    })
    const spec = execution.dispatchRequest.startRequest.spec
    expect(execution).toMatchObject({
      driver: 'codex-app-server',
      protocol: 'harness-broker/0.2',
      profile: {
        profileId: expect.any(String),
        profileHash: expect.any(String),
        compatibilityHash: expect.any(String),
        startRequestHash: expect.any(String),
      },
    })
    expect(spec.harness).toEqual({
      frontend: 'codex-cli',
      provider: 'openai',
      driver: 'codex-app-server',
    })
    expect(spec.process.harnessTransport).toEqual({ kind: 'jsonrpc-stdio' })
    expect(spec.process.lockedEnv).toMatchObject({ EXTRA_FLAG: '1' })
    expect(() =>
      validateInvocationStartRequest(execution.dispatchRequest.startRequest)
    ).not.toThrow()
  })

  test('maps requested resource limits into the start request and changes its hash', async () => {
    const common = {
      harness: 'codex' as const,
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    }
    const first = await compile({
      ...common,
      namespace: 'profile-limits-a',
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
    })
    const second = await compile({
      ...common,
      namespace: 'profile-limits-b',
      resourceLimits: { startupTimeoutMs: 11_000, turnTimeoutMs: 21_000 },
    })
    expect(first.dispatchRequest.startRequest.spec.process.limits).toEqual({
      startupTimeoutMs: 10_000,
      turnTimeoutMs: 20_000,
    })
    expect(second.dispatchRequest.startRequest.spec.process.limits).toEqual({
      startupTimeoutMs: 11_000,
      turnTimeoutMs: 21_000,
    })
    expect(second.profile.startRequestHash).not.toBe(first.profile.startRequestHash)
  })

  test('preserves deny policy and FIFO input policy on the canonical start spec', async () => {
    const execution = await compile({
      namespace: 'profile-policy',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'queue', maxDepth: 8 },
        supportedKinds: ['user'],
        attachmentPolicy: { localImages: true, fileRefs: false },
      },
    })
    expect(execution.dispatchRequest.startRequest.spec.driver).toMatchObject({
      kind: 'codex-app-server',
      permissionPolicy: { mode: 'deny' },
    })
    expect(execution.dispatchRequest.startRequest.spec.interaction).toMatchObject({
      inputQueue: 'fifo',
    })
  })

  test('derives presentation for Codex from the selection, not a driver selector', async () => {
    const execution = await compile({
      namespace: 'profile-codex-presentation',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: true,
    })
    expect(execution.presentationSurface).toEqual({
      transport: 'websocket-unix',
      terminalHost: 'tmux',
    })
    expect(execution.hosting).toMatchObject({ terminalRequired: true, terminalHost: 'tmux' })
  })

  test('keeps Claude presentation and terminal requirements together', async () => {
    const execution = await compile({
      namespace: 'profile-claude',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
    })
    expect(execution).toMatchObject({
      driver: 'claude-code-tmux',
      protocol: 'harness-broker/0.2',
      hosting: { executionTransport: 'pty', terminalRequired: true, terminalHost: 'tmux' },
    })
    expect(execution.dispatchRequest.startRequest.spec.process.harnessTransport).toEqual({
      kind: 'pty',
    })
  })

  test('keeps Muse headless and presentation routes distinct in the execution projection', async () => {
    const headless = await compile({
      namespace: 'profile-muse-headless',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: false,
    })
    const presentation = await compile({
      namespace: 'profile-muse-presentation',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: true,
    })
    expect(headless.driver).toBe('muse-serve')
    expect(headless.hosting.terminalRequired).toBe(false)
    expect(presentation.driver).toBe('muse-cli-tmux')
    expect(presentation.hosting).toMatchObject({ terminalRequired: true, terminalHost: 'tmux' })
  })
})
