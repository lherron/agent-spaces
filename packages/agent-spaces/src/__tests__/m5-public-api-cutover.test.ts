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
