import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createAgentSpacesClient } from './index.js'
import type { AgentEvent } from './types.js'

const client = createAgentSpacesClient()

// ---------------------------------------------------------------------------
// getHarnessCapabilities
// ---------------------------------------------------------------------------

describe('getHarnessCapabilities', () => {
  test('returns provider-typed harnesses with correct structure', async () => {
    const caps = await client.getHarnessCapabilities()
    expect(caps.harnesses.length).toBe(2)

    const anthropic = caps.harnesses.find((h) => h.provider === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic?.id).toBe('anthropic')
    expect(anthropic?.frontends).toContain('agent-sdk')
    expect(anthropic?.frontends).toContain('claude-code')
    expect(anthropic?.models.length).toBeGreaterThan(0)

    const openai = caps.harnesses.find((h) => h.provider === 'openai')
    expect(openai).toBeDefined()
    expect(openai?.id).toBe('openai')
    expect(openai?.frontends).toContain('pi-sdk')
    expect(openai?.frontends).toContain('codex-cli')
    expect(openai?.models.length).toBeGreaterThan(0)
  })

  test('includes both SDK and CLI models for each provider', async () => {
    const caps = await client.getHarnessCapabilities()
    const anthropic = caps.harnesses.find((h) => h.provider === 'anthropic')
    // Should include agent-sdk models (provider/model format) and claude-code models (bare names)
    expect(anthropic?.models).toContain('claude/sonnet')
    expect(anthropic?.models).toContain('claude-opus-4-6')

    const openai = caps.harnesses.find((h) => h.provider === 'openai')
    // Should include pi-sdk models (provider/model format) and codex-cli models (bare names)
    expect(openai?.models).toContain('openai-codex/gpt-5.3-codex')
    expect(openai?.models).toContain('gpt-5.3-codex')
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
        cpSessionId: 'test-session',
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
  test('returns model_not_supported and emits ordered events', async () => {
    const events: Array<{ type: string; seq: number }> = []

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-test',
      runId: 'run-test',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type, seq: event.seq })
        },
      },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('model_not_supported')
    expect(response.provider).toBe('anthropic')
    expect(response.frontend).toBe('agent-sdk')
    expect(events.map((e) => e.type)).toEqual(['state', 'message', 'state', 'complete'])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  test('emits events with cpSessionId and runId', async () => {
    const events: Array<{ cpSessionId: string; runId: string }> = []

    await client.runTurnNonInteractive({
      cpSessionId: 'cp-session-123',
      runId: 'run-456',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ cpSessionId: event.cpSessionId, runId: event.runId })
        },
      },
    })

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.cpSessionId).toBe('cp-session-123')
      expect(event.runId).toBe('run-456')
    }
  })

  test('returns continuation_not_found for missing pi session', async () => {
    const missingSessionPath = join(tmpdir(), `asp-missing-${Date.now()}`)
    await rm(missingSessionPath, { recursive: true, force: true })

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-missing',
      runId: 'run-missing',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.3-codex',
      continuation: { provider: 'openai', key: missingSessionPath },
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('continuation_not_found')
    expect(response.provider).toBe('openai')
    expect(response.frontend).toBe('pi-sdk')
  })

  test('returns provider_mismatch for wrong continuation provider', async () => {
    const events: Array<{ type: string }> = []

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-mismatch',
      runId: 'run-mismatch',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      // Agent-sdk is anthropic, but continuation says openai
      continuation: { provider: 'openai', key: 'some-key' },
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type })
        },
      },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.message).toContain('Provider mismatch')
    expect(response.result.error?.code).toBe('provider_mismatch')
    // Provider mismatch is caught during validation and emits error events
    expect(events.map((e) => e.type)).toEqual(['state', 'complete'])
  })

  test('sets pi-sdk continuation on first run', async () => {
    const events: Array<{ type: string; continuation?: unknown }> = []

    // This will fail during materialization since we don't have a real registry,
    // but we can verify the continuation was set on events before the failure
    await client.runTurnNonInteractive({
      cpSessionId: 'session-pi-first',
      runId: 'run-pi-first',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.3-codex',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type, continuation: event.continuation })
        },
      },
    })

    // The 'running' event should have a continuation set (pi session path)
    const runningEvent = events.find((e) => e.type === 'state')
    expect(runningEvent?.continuation).toBeDefined()
    const cont = runningEvent?.continuation as { provider: string; key: string }
    expect(cont.provider).toBe('openai')
    expect(cont.key).toContain('sessions/pi/')
  })

  test('uses default model when none specified and passes model validation', async () => {
    const events: AgentEvent[] = []

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-default-model',
      runId: 'run-default-model',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      // No model specified → should use default 'claude/sonnet' which is in the allowed list
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: (event) => events.push(event) },
    })

    // Should fail at materialization (no real registry), NOT at model validation
    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).not.toBe('model_not_supported')
    // Should emit running state + user message events before materialization failure
    const eventTypes = events.map((e) => e.type)
    expect(eventTypes).toContain('state')
    expect(eventTypes).toContain('message')
  })

  test('emits events with valid ISO timestamps', async () => {
    const events: AgentEvent[] = []

    await client.runTurnNonInteractive({
      cpSessionId: 'session-ts',
      runId: 'run-ts',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: (event) => events.push(event) },
    })

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      // Verify timestamp is a valid ISO 8601 string
      expect(typeof event.ts).toBe('string')
      const parsed = new Date(event.ts)
      expect(parsed.getTime()).not.toBeNaN()
      expect(parsed.toISOString()).toBe(event.ts)
    }
  })

  test('seq counter starts at 1 and increments monotonically', async () => {
    const seqs: number[] = []

    await client.runTurnNonInteractive({
      cpSessionId: 'session-seq',
      runId: 'run-seq',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: (event) => seqs.push(event.seq) },
    })

    expect(seqs.length).toBeGreaterThan(0)
    expect(seqs[0]).toBe(1)
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBe(seqs[i - 1] + 1)
    }
  })

  test('continuation_not_found response includes continuation ref', async () => {
    const missingPath = join(tmpdir(), `asp-missing-ref-${Date.now()}`)
    await rm(missingPath, { recursive: true, force: true })

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-cont-ref',
      runId: 'run-cont-ref',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.3-codex',
      continuation: { provider: 'openai', key: missingPath },
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    })

    // Response should include the continuation ref even on error
    expect(response.continuation).toBeDefined()
    expect(response.continuation?.provider).toBe('openai')
    expect(response.continuation?.key).toBe(missingPath)
  })

  test('model_not_supported response includes the rejected model id', async () => {
    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-bad-model',
      runId: 'run-bad-model',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'claude/nonexistent-variant',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('model_not_supported')
    expect(response.model).toBe('claude/nonexistent-variant')
  })

  test('pi-sdk first run generates deterministic continuation path from cpSessionId', async () => {
    const events1: Array<{ continuation?: unknown }> = []
    const events2: Array<{ continuation?: unknown }> = []

    // Run twice with the same cpSessionId
    for (const events of [events1, events2]) {
      await client.runTurnNonInteractive({
        cpSessionId: 'deterministic-session',
        runId: `run-${events === events1 ? '1' : '2'}`,
        aspHome: '/tmp/asp-test',
        spec: { spaces: ['space:base@dev'] },
        frontend: 'pi-sdk',
        model: 'openai-codex/gpt-5.3-codex',
        cwd: '/tmp',
        prompt: 'Hello',
        callbacks: {
          onEvent: (event) => events.push({ continuation: event.continuation }),
        },
      })
    }

    // Same cpSessionId should produce the same continuation key
    const cont1 = events1[0]?.continuation as { key: string } | undefined
    const cont2 = events2[0]?.continuation as { key: string } | undefined
    expect(cont1?.key).toBeDefined()
    expect(cont1?.key).toBe(cont2?.key)
  })

  test('user message event contains the prompt text', async () => {
    const events: AgentEvent[] = []

    await client.runTurnNonInteractive({
      cpSessionId: 'session-prompt',
      runId: 'run-prompt',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'This is my specific test prompt',
      callbacks: { onEvent: (event) => events.push(event) },
    })

    const messageEvent = events.find(
      (e) => e.type === 'message' && 'role' in e && e.role === 'user'
    )
    expect(messageEvent).toBeDefined()
    if (messageEvent && 'content' in messageEvent) {
      expect(messageEvent.content).toBe('This is my specific test prompt')
    }
  })

  test('returns error for relative cwd path', async () => {
    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-rel-cwd',
      runId: 'run-rel-cwd',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      cwd: 'relative/path',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    })

    expect(response.result.success).toBe(false)
    expect(response.result.error?.message).toContain('absolute path')
  })

  test('complete event contains RunResult', async () => {
    const events: AgentEvent[] = []

    await client.runTurnNonInteractive({
      cpSessionId: 'session-complete',
      runId: 'run-complete',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      cwd: '/tmp',
      prompt: 'Hello',
      callbacks: { onEvent: (event) => events.push(event) },
    })

    const completeEvent = events.find((e) => e.type === 'complete')
    expect(completeEvent).toBeDefined()
    if (completeEvent && 'result' in completeEvent) {
      expect(completeEvent.result).toBeDefined()
      expect(typeof completeEvent.result.success).toBe('boolean')
    }
  })
})

// ---------------------------------------------------------------------------
// runTurnInFlight + in-flight controls
// ---------------------------------------------------------------------------

describe('runTurnInFlight', () => {
  test('returns unsupported_frontend for non-agent-sdk frontends', async () => {
    const events: Array<{ type: string }> = []

    const response = await client.runTurnInFlight({
      cpSessionId: 'inflight-unsupported',
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
      client.queueInFlightInput({
        cpSessionId: 'missing-session',
        runId: 'missing-run',
        prompt: 'hello',
      })
    ).rejects.toThrow(/No active in-flight run/)
  })

  test('interruptInFlightTurn throws when no active run exists', async () => {
    await expect(
      client.interruptInFlightTurn({
        cpSessionId: 'missing-session',
      })
    ).rejects.toThrow(/No active in-flight run/)
  })
})
