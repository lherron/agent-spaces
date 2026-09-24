import { describe, expect, test } from 'bun:test'

import { createAgentSpacesClient } from '../../compiler/agent-spaces/src/index.js'
import { compilerRuntime } from './compiler-runtime.js'

const client = createAgentSpacesClient({ runtime: compilerRuntime })

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
