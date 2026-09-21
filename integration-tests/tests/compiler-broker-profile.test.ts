import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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

  test('keeps broker correlation flat and free of controller launch metadata', async () => {
    const execution = await compile({
      namespace: 'profile-correlation',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
      scopeRef: 'agent:cody:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
    })
    const spec = execution.dispatchRequest.startRequest.spec
    expect(spec.correlation).toMatchObject({
      scopeRef: 'agent:cody:project:agent-spaces:task:T-08704',
      laneRef: 'repair',
    })
    expect(spec.correlation).not.toHaveProperty('sessionRef')
    for (const value of Object.values(spec.correlation ?? {})) expect(typeof value).toBe('string')
    const serialized = JSON.stringify(spec)
    for (const forbidden of ['callbackSocket', 'spoolPath', 'persistence', '"hrc"', '"acp"']) {
      expect(serialized).not.toContain(forbidden)
    }
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

  test('threads denied Claude tools through the retained terminal execution policy', async () => {
    const execution = await compile({
      namespace: 'profile-claude-tool-policy',
      harness: 'claude',
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
      disallowedTools: ['Bash', 'Write'],
    })
    expect(execution.driver).toBe('claude-code-tmux')
    expect(execution.dispatchRequest.startRequest.spec.driver.kind).toBe('claude-code-tmux')
    expect(execution.dispatchRequest.startRequest.spec.process.args).toEqual(
      expect.arrayContaining(['--disallowedTools', 'Bash', 'Write'])
    )
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

  test('puts agent tools in the typed process PATH prepend instead of locked environment', async () => {
    const fixture = createV2CompileFixture()
    fixtures.push(fixture)
    const toolsBin = join(fixture.agentRoot, 'tools', 'bin')
    mkdirSync(toolsBin, { recursive: true })
    try {
      const response = await compileV2(fixture, {
        namespace: 'profile-tools-path',
        harness: 'codex',
        modelProvider: 'openai-codex',
        model: 'gpt-5.6-terra',
        presentation: false,
      })
      expect(response.ok).toBe(true)
      if (!response.ok) return
      const process = response.plan.execution.dispatchRequest.startRequest.spec.process
      expect(process.pathPrepend).toEqual([toolsBin])
      expect(process.lockedEnv).not.toHaveProperty('PATH')
    } finally {
      rmSync(join(fixture.agentRoot, 'tools'), { recursive: true, force: true })
    }
  })

  test('leaves pathPrepend absent for an agent without a tools directory', async () => {
    const execution = await compile({
      namespace: 'profile-no-tools',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    const process = execution.dispatchRequest.startRequest.spec.process
    expect(process.pathPrepend).toBeUndefined()
    expect(process.lockedEnv).not.toHaveProperty('PATH')
  })

  test.each([
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', false, 'native-worker'],
    ['agent-harness', 'openai-codex', 'gpt-5.6-terra', true, 'native-worker'],
    ['claude', 'anthropic', 'claude-sonnet-4-5', false, 'pty'],
    ['codex', 'openai-codex', 'gpt-5.6-terra', false, 'jsonrpc-stdio'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', false, 'jsonrpc-stdio'],
    ['muse', 'meta', 'muse-spark-1.3-contributor', true, 'pty'],
  ] as const)(
    'keeps %s presentation=%s on its explicit broker transport',
    async (harness, modelProvider, model, presentation, transport) => {
      const execution = await compile({
        namespace: `profile-transport-${harness}-${presentation}`,
        harness,
        modelProvider,
        model,
        presentation,
      })
      expect(execution.hosting.executionTransport).toBe(transport)
      expect(execution.dispatchRequest.startRequest.spec.process.harnessTransport).toEqual({
        kind: transport,
      })
    }
  )

  test('keeps non-presentation Codex outside a terminal-hosted execution surface', async () => {
    const execution = await compile({
      namespace: 'profile-codex-headless-hosting',
      harness: 'codex',
      modelProvider: 'openai-codex',
      model: 'gpt-5.6-terra',
      presentation: false,
    })
    expect(execution.hosting).toMatchObject({
      terminalRequired: false,
      processExecution: 'broker-process',
    })
    expect(execution).not.toHaveProperty('presentationSurface')
  })

  test('keeps a required terminal surface in the execution recipe instead of dispatch environment', async () => {
    const execution = await compile({
      namespace: 'profile-terminal-recipe',
      harness: 'muse',
      modelProvider: 'meta',
      model: 'muse-spark-1.3-contributor',
      presentation: true,
    })
    expect(execution.presentationSurface).toEqual({ transport: 'terminal', terminalHost: 'tmux' })
    expect(execution.dispatchRequest.dispatchEnv).toBeUndefined()
    expect(execution.dispatchRequest.startRequest.spec).not.toHaveProperty('runtime')
  })

  test('changes broker mechanics when denied tools change for the selected Claude harness', async () => {
    const common = {
      harness: 'claude' as const,
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      presentation: true,
    }
    const bashOnly = await compile({
      ...common,
      namespace: 'profile-tool-hash-a',
      disallowedTools: ['Bash'],
    })
    const bashAndWrite = await compile({
      ...common,
      namespace: 'profile-tool-hash-b',
      disallowedTools: ['Bash', 'Write'],
    })
    expect(bashAndWrite.profile.compatibilityHash).not.toBe(bashOnly.profile.compatibilityHash)
    expect(bashAndWrite.profile.startRequestHash).not.toBe(bashOnly.profile.startRequestHash)
  })
})
