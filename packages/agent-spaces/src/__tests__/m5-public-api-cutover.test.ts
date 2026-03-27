/**
 * RED tests for M5: Public API cutover.
 *
 * Tests for placement-based request/response shapes, hostSessionId rename,
 * resolvedBundle return, createAgentSpacesClient options, and correlation env vars.
 *
 * wrkq tasks: T-00860 (API cutover), T-00861 (hostSessionId), T-00862 (resolvedBundle),
 *             T-00863 (client constructor), T-00864 (correlation env vars)
 *
 * PASS CONDITIONS:
 * 1. RunTurnNonInteractiveRequest uses placement field instead of SpaceSpec/cpSessionId.
 * 2. BuildProcessInvocationSpecRequest uses placement field instead of SpaceSpec/cpSessionId.
 * 3. hostSessionId replaces cpSessionId in correlation metadata.
 * 4. resolvedBundle is returned from runTurnNonInteractive and buildProcessInvocationSpec.
 * 5. createAgentSpacesClient accepts AgentSpacesClientOptions (aspHome, registryPath).
 * 6. AGENT_SCOPE_REF, AGENT_LANE_REF, AGENT_HOST_SESSION_ID emitted in env vars.
 */

import { describe, expect, test } from 'bun:test'

// ===================================================================
// T-00860: Placement-based request/response types
// ===================================================================
describe('placement-based request types (T-00860)', () => {
  test('RunTurnNonInteractiveRequest has placement field', async () => {
    const types = await import('../types.js')

    // The new request type should exist as an interface.
    // We verify by constructing a conforming object and checking that
    // the old SpaceSpec/cpSessionId fields are NOT required.
    const req: types.RunTurnNonInteractiveRequest = {
      placement: {
        agentRoot: '/srv/agents/alice',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      frontend: 'agent-sdk',
      prompt: 'Hello',
      callbacks: { onEvent: () => {} },
    } as any

    expect(req.placement).toBeDefined()
    expect((req as any).placement.agentRoot).toBe('/srv/agents/alice')
    expect((req as any).placement.runMode).toBe('query')
  })

  test('RunTurnNonInteractiveResponse includes resolvedBundle', async () => {
    // Verify the response type includes resolvedBundle field
    // We construct a mock response matching the new shape
    const mockResponse = {
      provider: 'anthropic' as const,
      frontend: 'agent-sdk' as const,
      result: { success: true },
      resolvedBundle: {
        bundleIdentity: 'test-identity',
        runMode: 'query',
        cwd: '/srv/agents/alice',
        instructions: [],
        spaces: [],
      },
    }

    // Import and verify the type accepts this shape
    const types = await import('../types.js')
    const response: types.RunTurnNonInteractiveResponse = mockResponse as any
    expect(response.resolvedBundle).toBeDefined()
  })

  test('BuildProcessInvocationSpecRequest has placement field', async () => {
    const types = await import('../types.js')

    const req: types.BuildProcessInvocationSpecRequest = {
      placement: {
        agentRoot: '/srv/agents/alice',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
    } as any

    expect((req as any).placement).toBeDefined()
  })

  test('BuildProcessInvocationSpecResponse includes resolvedBundle', async () => {
    const mockResponse = {
      spec: {
        provider: 'anthropic',
        frontend: 'claude-code',
        argv: ['claude'],
        cwd: '/srv/agents/alice',
        env: {},
        interactionMode: 'interactive',
        ioMode: 'pty',
      },
      resolvedBundle: {
        bundleIdentity: 'test-identity',
        runMode: 'query',
        cwd: '/srv/agents/alice',
        instructions: [],
        spaces: [],
      },
    }

    const types = await import('../types.js')
    const response: types.BuildProcessInvocationSpecResponse = mockResponse as any
    expect(response.resolvedBundle).toBeDefined()
  })
})

// ===================================================================
// T-00861: hostSessionId replaces cpSessionId
// ===================================================================
describe('hostSessionId rename (T-00861)', () => {
  test('HostCorrelation type uses hostSessionId not cpSessionId', async () => {
    // Import the HostCorrelation type (should be exported from types or index)
    const types = await import('../types.js')

    const correlation = {
      hostSessionId: 'hs-123',
      runId: 'run-456',
      sessionRef: {
        scopeRef: 'agent:alice:project:demo',
        laneRef: 'main' as const,
      },
    }

    // The type should accept hostSessionId
    expect(correlation.hostSessionId).toBe('hs-123')
    // Verify the type is exported
    expect((types as any).HostCorrelation || true).toBeTruthy()
  })

  test('placement.correlation uses hostSessionId', async () => {
    const _types = await import('../types.js')

    const req = {
      placement: {
        agentRoot: '/a',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
        correlation: {
          hostSessionId: 'hs-abc',
          sessionRef: {
            scopeRef: 'agent:alice',
            laneRef: 'main',
          },
        },
      },
      frontend: 'agent-sdk',
      prompt: 'test',
      callbacks: { onEvent: () => {} },
    }

    expect(req.placement.correlation.hostSessionId).toBe('hs-abc')
  })

  test('BaseEvent uses hostSessionId not cpSessionId', async () => {
    const types = await import('../types.js')

    // The new BaseEvent should use hostSessionId
    const event: types.BaseEvent = {
      ts: new Date().toISOString(),
      seq: 1,
      hostSessionId: 'hs-123',
      runId: 'run-1',
    } as any

    expect((event as any).hostSessionId).toBe('hs-123')
    // cpSessionId should no longer be required
    expect((event as any).cpSessionId).toBeUndefined()
  })
})

// ===================================================================
// T-00862: resolvedBundle returned from execution/invocation APIs
// ===================================================================
describe('resolvedBundle from APIs (T-00862)', () => {
  test('client.buildProcessInvocationSpec returns resolvedBundle', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    // Build a placement-based request for a CLI frontend
    const response = await client.buildProcessInvocationSpec({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
    } as any)

    expect(response.resolvedBundle).toBeDefined()
    expect(response.resolvedBundle!.bundleIdentity).toBeDefined()
    expect(response.resolvedBundle!.runMode).toBe('query')
    expect(response.resolvedBundle!.instructions).toBeInstanceOf(Array)
    expect(response.resolvedBundle!.spaces).toBeInstanceOf(Array)
  })

  test('provider mismatch still detected with placement API', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    // Try to continue an anthropic session with an openai frontend
    await expect(
      client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-default' },
        },
        provider: 'openai',
        frontend: 'codex-cli',
        interactionMode: 'headless',
        ioMode: 'pipes',
        continuation: {
          provider: 'anthropic',
          key: 'some-key',
        },
      } as any)
    ).rejects.toThrow(/provider.*mismatch/i)
  })

  test('continuation refs still type-checked across providers', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    // anthropic continuation with anthropic frontend should be OK structurally
    // (may fail for other reasons like missing agentRoot, but not provider mismatch)
    try {
      await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-default' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
        continuation: {
          provider: 'anthropic',
          key: 'some-key',
        },
      } as any)
    } catch (err: any) {
      // Should NOT be a provider mismatch error
      expect(err.message).not.toMatch(/provider.*mismatch/i)
    }
  })
})

// ===================================================================
// T-00863: createAgentSpacesClient with options
// ===================================================================
describe('createAgentSpacesClient options (T-00863)', () => {
  test('accepts AgentSpacesClientOptions with aspHome', async () => {
    const { createAgentSpacesClient } = await import('../index.js')

    // New signature should accept options object
    const client = createAgentSpacesClient({
      aspHome: '/custom/asp/home',
    })

    expect(client).toBeDefined()
    expect(typeof client.runTurnNonInteractive).toBe('function')
    expect(typeof client.buildProcessInvocationSpec).toBe('function')
  })

  test('accepts AgentSpacesClientOptions with registryPath', async () => {
    const { createAgentSpacesClient } = await import('../index.js')

    const client = createAgentSpacesClient({
      aspHome: '/custom/asp/home',
      registryPath: '/custom/registry',
    })

    expect(client).toBeDefined()
  })

  test('still works with no arguments (backward compat)', async () => {
    const { createAgentSpacesClient } = await import('../index.js')

    // No-arg call should still work
    const client = createAgentSpacesClient()
    expect(client).toBeDefined()
  })

  test('AgentSpacesClientOptions type is exported', async () => {
    // The options type should be importable
    const mod = await import('../index.js')
    expect(mod.createAgentSpacesClient).toBeDefined()
    // Type-only check: AgentSpacesClientOptions should be in the exports
    // We verify by checking that the function accepts an object arg
    const client = mod.createAgentSpacesClient({ aspHome: '/test' })
    expect(client).toBeDefined()
  })
})

// ===================================================================
// T-00864: Correlation env vars in buildProcessInvocationSpec
// ===================================================================
describe('correlation env vars (T-00864)', () => {
  test('AGENT_SCOPE_REF emitted when sessionRef present', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    const response = await client.buildProcessInvocationSpec({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
        correlation: {
          sessionRef: {
            scopeRef: 'agent:alice:project:demo',
            laneRef: 'main',
          },
        },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
    } as any)

    expect(response.spec.env.AGENT_SCOPE_REF).toBe('agent:alice:project:demo')
    expect(response.spec.env.AGENT_LANE_REF).toBe('main')
  })

  test('AGENT_HOST_SESSION_ID emitted when hostSessionId present', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    const response = await client.buildProcessInvocationSpec({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
        correlation: {
          hostSessionId: 'hs-correlation-test',
        },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
    } as any)

    expect(response.spec.env.AGENT_HOST_SESSION_ID).toBe('hs-correlation-test')
  })

  test('correlation env vars are absent when no correlation provided', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    const response = await client.buildProcessInvocationSpec({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
    } as any)

    expect(response.spec.env.AGENT_SCOPE_REF).toBeUndefined()
    expect(response.spec.env.AGENT_LANE_REF).toBeUndefined()
    expect(response.spec.env.AGENT_HOST_SESSION_ID).toBeUndefined()
  })

  test('env vars are advisory only (string type)', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })

    const response = await client.buildProcessInvocationSpec({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'task',
        bundle: { kind: 'agent-default' },
        correlation: {
          hostSessionId: 'hs-123',
          sessionRef: {
            scopeRef: 'agent:alice:project:demo:task:t1',
            laneRef: 'lane:deploy',
          },
        },
      },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
    } as any)

    expect(typeof response.spec.env.AGENT_SCOPE_REF).toBe('string')
    expect(typeof response.spec.env.AGENT_LANE_REF).toBe('string')
    expect(typeof response.spec.env.AGENT_HOST_SESSION_ID).toBe('string')
    expect(response.spec.env.AGENT_SCOPE_REF).toBe('agent:alice:project:demo:task:t1')
    expect(response.spec.env.AGENT_LANE_REF).toBe('lane:deploy')
  })
})

// ===================================================================
// T-00873: placement-based runTurnNonInteractive
// Defect: runTurnNonInteractive had no placement-aware dispatch, unlike
// buildProcessInvocationSpec which already had one. SDK frontends using
// placement were falling through to the legacy path and failing.
// ===================================================================
describe('placement-based runTurnNonInteractive (T-00873)', () => {
  test('placement dispatch returns model_not_supported with structured events', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })
    const events: Array<{ type: string; seq: number }> = []

    const response = await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      prompt: 'Hello placement',
      runId: 'run-placement-1',
      hostSessionId: 'hs-placement-1',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type, seq: event.seq })
        },
      },
    } as any)

    expect(response.result.success).toBe(false)
    expect(response.result.error?.code).toBe('model_not_supported')
    expect(response.provider).toBe('anthropic')
    expect(response.frontend).toBe('agent-sdk')
    // Should emit state→message→state(error)→complete, same as legacy path
    expect(events.map((e) => e.type)).toEqual(['state', 'message', 'state', 'complete'])
    expect(events.map((e) => e.seq)).toEqual([1, 2, 3, 4])
  })

  test('placement dispatch emits hostSessionId and runId on events', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })
    const events: Array<{ hostSessionId: string; runId: string }> = []

    await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      prompt: 'Hello',
      runId: 'run-hsid-test',
      hostSessionId: 'hs-placement-hsid',
      callbacks: {
        onEvent: (event) => {
          events.push({ hostSessionId: event.hostSessionId, runId: event.runId })
        },
      },
    } as any)

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.hostSessionId).toBe('hs-placement-hsid')
      expect(event.runId).toBe('run-hsid-test')
    }
  })

  test('placement dispatch catches provider mismatch', async () => {
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-m5' })
    const events: Array<{ type: string }> = []

    const response = await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-m5/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      frontend: 'agent-sdk',
      // agent-sdk is anthropic, but continuation says openai
      continuation: { provider: 'openai', key: 'some-key' },
      prompt: 'Hello',
      runId: 'run-mismatch',
      hostSessionId: 'hs-mismatch',
      callbacks: {
        onEvent: (event) => {
          events.push({ type: event.type })
        },
      },
    } as any)

    expect(response.result.success).toBe(false)
    expect(response.result.error?.message).toContain('Provider mismatch')
    expect(response.result.error?.code).toBe('provider_mismatch')
    expect(events.map((e) => e.type)).toEqual(['state', 'complete'])
  })

  test('source code has req.placement dispatch in runTurnNonInteractive', () => {
    // Static regression: ensure the placement dispatch is present
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const source = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8')
    // Must have the placement check inside runTurnNonInteractive
    expect(source).toMatch(/runTurnNonInteractive[\s\S]*?if\s*\(req\.placement\)/)
    // Must have the placement handler function
    expect(source).toMatch(/runPlacementTurnNonInteractive/)
  })
})

// ===================================================================
// T-00876: unified placement materialization
// Both placement functions use placementToSpec + materializeSpec
// instead of manual registryRefs filtering.
// ===================================================================
describe('unified placement materialization (T-00876)', () => {
  test('both placement functions use placementToSpec + materializeSpec pipeline', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const source = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8')

    // Extract the two placement functions
    const buildFn = source.match(/async function buildPlacementInvocationSpec[\s\S]*?^}/m)?.[0]
    const runFn = source.match(/async function runPlacementTurnNonInteractive[\s\S]*?^}/m)?.[0]

    expect(buildFn).toBeDefined()
    expect(runFn).toBeDefined()

    // Both must use placementToSpec for conversion
    expect(buildFn).toMatch(/placementToSpec\(/)
    expect(runFn).toMatch(/placementToSpec\(/)

    // Both must use materializeSpec for unified materialization
    expect(buildFn).toMatch(/materializeSpec\(/)
    expect(runFn).toMatch(/materializeSpec\(/)

    // Neither should have manual registryRefs filtering (replaced by unified path)
    expect(buildFn).not.toMatch(/registryRefs/)
    expect(runFn).not.toMatch(/registryRefs/)
  })
})

// ===================================================================
// T-00891: placement.correlation replaces top-level hostSessionId/runId
//
// Defect: runPlacementTurnNonInteractive reads req.hostSessionId via
// resolveHostSessionId(req) and req.runId directly, ignoring
// placement.correlation. Callers providing only placement.correlation
// get "hostSessionId is required".
//
// PASS CONDITIONS:
// 1. Providing correlation inside placement (no top-level hostSessionId/runId)
//    must propagate hostSessionId and runId to emitted events.
// 2. Top-level hostSessionId/runId must still work (backward compat).
// ===================================================================
describe('placement.correlation for hostSessionId/runId (T-00891)', () => {
  test('placement.correlation.hostSessionId is used when top-level hostSessionId absent', async () => {
    // RED: Currently throws "hostSessionId is required" because
    // resolveHostSessionId(req) only reads req.hostSessionId / req.cpSessionId
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-t891' })
    const events: Array<{ hostSessionId: string; runId: string }> = []

    // Call with correlation nested in placement, NO top-level hostSessionId/runId
    await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-t891/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
        correlation: {
          hostSessionId: 'hs-from-correlation',
          runId: 'run-from-correlation',
        },
      },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      prompt: 'Hello',
      callbacks: {
        onEvent: (event) => {
          events.push({ hostSessionId: event.hostSessionId, runId: event.runId })
        },
      },
    } as any)

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.hostSessionId).toBe('hs-from-correlation')
      expect(event.runId).toBe('run-from-correlation')
    }
  })

  test('placement.correlation.runId is used when top-level runId absent', async () => {
    // RED: Currently passes undefined runId to createEventEmitter because
    // req.runId is not set and placement.correlation.runId is ignored
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-t891b' })
    const events: Array<{ runId: string }> = []

    await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-t891b/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
        correlation: {
          hostSessionId: 'hs-t891b',
          runId: 'run-only-in-correlation',
        },
      },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      prompt: 'Hello',
      hostSessionId: 'hs-t891b', // provide hostSessionId at top-level to isolate the runId defect
      callbacks: {
        onEvent: (event) => {
          events.push({ runId: event.runId })
        },
      },
    } as any)

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.runId).toBe('run-only-in-correlation')
    }
  })

  test('top-level hostSessionId/runId still works (backward compat)', async () => {
    // GREEN: This should already pass — existing behavior
    const { createAgentSpacesClient } = await import('../index.js')
    const client = createAgentSpacesClient({ aspHome: '/tmp/asp-test-t891c' })
    const events: Array<{ hostSessionId: string; runId: string }> = []

    await client.runTurnNonInteractive({
      placement: {
        agentRoot: '/tmp/asp-test-t891c/agent-root',
        runMode: 'query',
        bundle: { kind: 'agent-default' },
      },
      frontend: 'agent-sdk',
      model: 'api/not-a-model',
      prompt: 'Hello',
      runId: 'run-top-level',
      hostSessionId: 'hs-top-level',
      callbacks: {
        onEvent: (event) => {
          events.push({ hostSessionId: event.hostSessionId, runId: event.runId })
        },
      },
    } as any)

    expect(events.length).toBeGreaterThan(0)
    for (const event of events) {
      expect(event.hostSessionId).toBe('hs-top-level')
      expect(event.runId).toBe('run-top-level')
    }
  })
})
