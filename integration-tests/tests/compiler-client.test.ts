import { describe, expect, test } from 'bun:test'

// Repo-level parity coverage deliberately composes the compiler and turn-runner
// roots from integration-tests, which sits above the six package roots.
import { createAgentSpacesClient as createTurnRunnerClient } from '../../apps/turn-runner/src/index.js'
import { createAgentSpacesClient } from '../../compiler/agent-spaces/src/index.js'
import { compilerRuntime } from './compiler-runtime.js'

const client = createAgentSpacesClient({ runtime: compilerRuntime })
const turnClient = createTurnRunnerClient()

// ---------------------------------------------------------------------------
// getHarnessCapabilities
// ---------------------------------------------------------------------------

describe('getHarnessCapabilities', () => {
  test('returns provider-typed harnesses with correct structure', async () => {
    const caps = await client.getHarnessCapabilities()
    expect(caps.harnesses.map((h) => h.id)).toEqual(['agent-harness', 'claude', 'codex', 'muse'])

    const claude = caps.harnesses.find((h) => h.id === 'claude')
    expect(claude).toMatchObject({ provider: 'anthropic', frontends: ['claude-code'] })
    expect(claude?.models.length).toBeGreaterThan(0)

    const codex = caps.harnesses.find((h) => h.id === 'codex')
    expect(codex).toMatchObject({ provider: 'openai-codex', frontends: ['codex-cli'] })
    expect(codex?.models.length).toBeGreaterThan(0)
  })

  test('keeps provider and model identity separate for each harness', async () => {
    const caps = await client.getHarnessCapabilities()
    expect(caps.harnesses.find((h) => h.id === 'claude')?.models).toContain('opus[1m]')
    expect(caps.harnesses.find((h) => h.id === 'codex')?.models).toContain('gpt-5.6-terra')
    for (const harness of caps.harnesses) {
      expect(harness.models.some((model) => model.includes('/'))).toBe(false)
    }
  })
})

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

describe('resolve', () => {
  test('returns resolve_failed for invalid spec with relative path', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: 'default', targetDir: 'relative/path' } },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
    expect(result.error?.message).toContain('absolute path')
  })

  test('returns resolve_failed for empty spaces array', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { spaces: [] },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
    expect(result.error?.message).toContain('at least one space reference')
  })

  test('returns resolve_failed for target without targetName', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: '', targetDir: '/tmp' } },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
    expect(result.error?.message).toContain('targetName')
  })

  test('returns resolve_failed for non-existent target directory', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: 'test', targetDir: '/nonexistent/path/to/project' } },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
  })

  test('error includes stack trace in details', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: 'default', targetDir: 'relative/path' } },
    })

    expect(result.error?.details).toBeDefined()
    expect(result.error?.details?.['stack']).toBeDefined()
    expect(typeof result.error?.details?.['stack']).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// buildProcessInvocationSpec
// ---------------------------------------------------------------------------

describe('buildProcessInvocationSpec', () => {
  test('throws on provider mismatch between request and frontend', async () => {
    // claude-code requires provider 'anthropic', but we pass 'openai'
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/[Pp]rovider mismatch/)
  })

  test('throws on provider mismatch between continuation and frontend', async () => {
    // codex-cli is openai, but continuation says anthropic
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'headless',
        ioMode: 'pipes',
        continuation: { provider: 'anthropic', key: 'some-key' },
        cwd: '/tmp',
      })
    ).rejects.toThrow(/[Pp]rovider mismatch/)
  })

  test('throws on unsupported model for claude-code', async () => {
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'anthropic',
        frontend: 'claude-code',
        model: 'not-a-real-model',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/[Mm]odel not supported/)
  })

  test('throws on unsupported model for codex-cli', async () => {
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'codex-cli',
        model: 'not-a-real-model',
        interactionMode: 'headless',
        ioMode: 'pipes',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/[Mm]odel not supported/)
  })

  test('throws on invalid spec with relative targetDir', async () => {
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { target: { targetName: 'test', targetDir: 'relative/path' } },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/absolute path/)
  })

  test('throws on empty spaces array', async () => {
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: [] },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/at least one space reference/)
  })

  test('provider mismatch error carries provider_mismatch code', async () => {
    try {
      await client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
      throw new Error('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as { code?: string }).code).toBe('provider_mismatch')
    }
  })

  test('continuation provider mismatch error carries provider_mismatch code', async () => {
    try {
      await client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'headless',
        ioMode: 'pipes',
        continuation: { provider: 'anthropic', key: 'some-key' },
        cwd: '/tmp',
      })
      throw new Error('Should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(Error)
      expect((e as { code?: string }).code).toBe('provider_mismatch')
    }
  })

  test('throws on relative cwd path', async () => {
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: 'relative/path',
      })
    ).rejects.toThrow(/absolute path/)
  })

  test('validates provider before continuation', async () => {
    // Even with a valid continuation, provider mismatch on the request itself is caught first
    await expect(
      client.buildProcessInvocationSpec({
        hostSessionId: 'test-session',
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        provider: 'openai',
        frontend: 'claude-code',
        continuation: { provider: 'openai', key: 'some-key' },
        interactionMode: 'interactive',
        ioMode: 'pty',
        cwd: '/tmp',
      })
    ).rejects.toThrow(/[Pp]rovider mismatch/)
  })
})

// ---------------------------------------------------------------------------
// runTurnNonInteractive
// ---------------------------------------------------------------------------

describe('runTurnNonInteractive', () => {
  test('fails closed for every retired direct SDK frontend before materialization', async () => {
    const requests = [
      { frontend: 'agent-sdk' as const, provider: 'anthropic' },
      { frontend: 'pi-sdk' as const, provider: 'openai' },
    ] as const

    for (const { frontend, provider } of requests) {
      const hostSessionId = `direct-${frontend}`
      const runId = `${hostSessionId}-run`
      const events: Array<{ type: string; hostSessionId: string; runId: string }> = []
      const response = await turnClient.runTurnNonInteractive({
        hostSessionId,
        runId,
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        frontend,
        cwd: '/tmp',
        prompt: 'Hello',
        callbacks: {
          onEvent: (event) => {
            events.push({
              type: event.type,
              hostSessionId: event.hostSessionId,
              runId: event.runId,
            })
          },
        },
      })

      expect(response.result.success).toBe(false)
      expect(response.result.error).toMatchObject({
        code: 'unsupported_frontend',
        message:
          'Direct SDK turn requests are retired; supply placement so ASP resolves the canonical harness.',
      })
      expect(response.provider).toBe(provider)
      expect(response.frontend).toBe(frontend)
      expect(events).toEqual([
        { type: 'state', hostSessionId, runId },
        { type: 'complete', hostSessionId, runId },
      ])
    }
  })
})

// ---------------------------------------------------------------------------
// runTurnInFlight + in-flight controls
// ---------------------------------------------------------------------------

describe('runTurnInFlight', () => {
  test('also fails closed for a retired direct SDK request', async () => {
    const events: Array<{ type: string }> = []

    const response = await turnClient.runTurnInFlight({
      hostSessionId: 'inflight-unsupported',
      runId: 'run-inflight-unsupported',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.3-codex',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type })
        },
      },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('unsupported_frontend')
    expect(events.map((e) => e.type)).toEqual(['state', 'complete'])
  })
})

describe('in-flight control methods', () => {
  test('queueInFlightInput throws when no active run exists', async () => {
    await expect(
      turnClient.queueInFlightInput({
        hostSessionId: 'missing-session',
        runId: 'missing-run',
        prompt: 'hello',
      })
    ).rejects.toThrow(/No active in-flight run/)
  })

  test('interruptInFlightTurn throws when no active run exists', async () => {
    await expect(
      turnClient.interruptInFlightTurn({
        hostSessionId: 'missing-session',
      })
    ).rejects.toThrow(/No active in-flight run/)
  })
})
