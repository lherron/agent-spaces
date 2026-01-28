import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { createAgentSpacesClient } from './index.js'

const client = createAgentSpacesClient()

describe('agent-spaces client', () => {
  test('getHarnessCapabilities returns provider-typed harnesses', async () => {
    const caps = await client.getHarnessCapabilities()
    expect(caps.harnesses.length).toBe(2)

    const anthropic = caps.harnesses.find((h) => h.provider === 'anthropic')
    expect(anthropic).toBeDefined()
    expect(anthropic?.frontends).toContain('agent-sdk')
    expect(anthropic?.frontends).toContain('claude-code')
    expect(anthropic?.models.length).toBeGreaterThan(0)

    const openai = caps.harnesses.find((h) => h.provider === 'openai')
    expect(openai).toBeDefined()
    expect(openai?.frontends).toContain('pi-sdk')
    expect(openai?.frontends).toContain('codex-cli')
    expect(openai?.models.length).toBeGreaterThan(0)
  })

  test('resolve returns resolve_failed for invalid spec', async () => {
    const result = await client.resolve({
      aspHome: '/tmp/asp-test',
      spec: { target: { targetName: 'default', targetDir: 'relative/path' } },
    })

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('resolve_failed')
  })

  test('runTurnNonInteractive returns model_not_supported and emits ordered events', async () => {
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

  test('runTurnNonInteractive emits events with cpSessionId and runId', async () => {
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

  test('runTurnNonInteractive returns continuation_not_found for missing pi session', async () => {
    const missingSessionPath = join(tmpdir(), `asp-missing-${Date.now()}`)
    await rm(missingSessionPath, { recursive: true, force: true })

    const response = await client.runTurnNonInteractive({
      cpSessionId: 'session-missing',
      runId: 'run-missing',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.2-codex',
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

  test('runTurnNonInteractive returns provider_mismatch for wrong continuation provider', async () => {
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
    // Provider mismatch is caught during validation and emits error events
    expect(events.map((e) => e.type)).toEqual(['state', 'complete'])
  })

  test('runTurnNonInteractive sets pi-sdk continuation on first run', async () => {
    const events: Array<{ type: string; continuation?: unknown }> = []

    // This will fail during materialization since we don't have a real registry,
    // but we can verify the continuation was set on events before the failure
    await client.runTurnNonInteractive({
      cpSessionId: 'session-pi-first',
      runId: 'run-pi-first',
      aspHome: '/tmp/asp-test',
      spec: { spaces: ['space:base@dev'] },
      frontend: 'pi-sdk',
      model: 'openai-codex/gpt-5.2-codex',
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
})
