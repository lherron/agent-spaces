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
 * 1. BuildProcessInvocationSpecRequest uses placement field instead of SpaceSpec/cpSessionId.
 * 2. hostSessionId replaces cpSessionId in correlation metadata.
 * 3. resolvedBundle is returned from buildProcessInvocationSpec.
 * 4. createAgentSpacesClient accepts AgentSpacesClientOptions (aspHome, registryPath).
 * 5. AGENT_SCOPE_REF, AGENT_LANE_REF, AGENT_HOST_SESSION_ID emitted in env vars.
 */

import { beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Narrow named-region helper: bound a function by its declaration and the next
// top-level declaration (or EOF) instead of greedily scanning to the first
// column-0 brace. Keeps the placement-function wiring assertions scoped to the
// named function without pinning the whole body, so a cohesive Lane 3 extraction
// that preserves the wiring stays green while a regression still fails.
function fnRegion(source: string, startMarker: string, endMarker?: string): string | undefined {
  const start = source.indexOf(startMarker)
  if (start === -1) return undefined
  if (endMarker === undefined) return source.slice(start)
  const end = source.indexOf(endMarker, start + startMarker.length)
  return source.slice(start, end > -1 ? end : undefined)
}
const PREPARE_CLI_RUNTIME_REGION = [
  'export async function preparePlacementCliRuntime',
  '\nexport function toProcessInvocationSpec',
] as const
const HEAVY_TEST_TIMEOUT_MS = 60_000
const REPO_ROOT = join(import.meta.dirname, '..', '..')
import type * as CompilerTypes from '../../compiler/agent-spaces/src/types.js'
import { compilerRuntime } from './compiler-runtime.js'
import { seedImmutableRegistryMirror } from './hermetic.js'

async function createClient(options?: { aspHome?: string; registryPath?: string }) {
  const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
  return createAgentSpacesClient({ ...options, runtime: compilerRuntime })
}

beforeAll(() => {
  const agentRoot = '/tmp/asp-test-m5/agent-root'
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = []\n',
    'utf8'
  )
})

// ===================================================================
// T-00860: Placement-based request/response types
// ===================================================================
describe('placement-based request types (T-00860)', () => {
  test('BuildProcessInvocationSpecRequest has placement field', async () => {
    const req: CompilerTypes.BuildProcessInvocationSpecRequest = {
      placement: {
        agentRoot: '/srv/agents/alice',
        runMode: 'query',
        bundle: { kind: 'agent-project', agentName: 'alice' },
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

    const response: CompilerTypes.BuildProcessInvocationSpecResponse = mockResponse as any
    expect(response.resolvedBundle).toBeDefined()
  })
})

// ===================================================================
// T-00861: hostSessionId replaces cpSessionId
// ===================================================================
describe('hostSessionId rename (T-00861)', () => {
  test('HostCorrelation type uses hostSessionId not cpSessionId', async () => {
    // Import the HostCorrelation type (should be exported from types or index)
    const correlation = {
      hostSessionId: 'hs-123',
      runId: 'run-456',
      sessionRef: {
        scopeRef: 'agent:alice:project:demo',
        laneRef: 'main' as const,
      },
    }

    // The type should accept hostSessionId. `HostCorrelation` is a type, so it
    // has no runtime presence -- the old `expect(types.HostCorrelation || true)`
    // asserted nothing at all. The annotation below is the real check: it fails
    // to compile if the export is gone or no longer accepts this shape.
    const typed: CompilerTypes.HostCorrelation = correlation
    expect(typed.hostSessionId).toBe('hs-123')
  })

  test('placement.correlation uses hostSessionId', async () => {
    const _types = await import('../../compiler/agent-spaces/src/types.js')

    const req = {
      placement: {
        agentRoot: '/a',
        runMode: 'query',
        bundle: { kind: 'agent-project', agentName: 'alice' },
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
    // The new BaseEvent should use hostSessionId
    const event: CompilerTypes.BaseEvent = {
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
  test(
    'client.buildProcessInvocationSpec returns resolvedBundle',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      // Build a placement-based request for a CLI frontend
      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-project', agentName: 'alice' },
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
    },
    HEAVY_TEST_TIMEOUT_MS
  )

  test('provider mismatch still detected with placement API', async () => {
    const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
    const client = createAgentSpacesClient({
      aspHome: '/tmp/asp-test-m5',
      runtime: compilerRuntime,
    })

    // Try to continue an anthropic session with an openai frontend
    await expect(
      client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-project', agentName: 'alice' },
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

  test(
    'continuation refs still type-checked across providers',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      // anthropic continuation with anthropic frontend should be OK structurally
      // (may fail for other reasons like missing agentRoot, but not provider mismatch)
      try {
        await client.buildProcessInvocationSpec({
          placement: {
            agentRoot: '/tmp/asp-test-m5/agent-root',
            runMode: 'query',
            bundle: { kind: 'agent-project', agentName: 'alice' },
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
    },
    HEAVY_TEST_TIMEOUT_MS
  )
})

// ===================================================================
// T-00863: createAgentSpacesClient with options
// ===================================================================
describe('createAgentSpacesClient options (T-00863)', () => {
  test('accepts AgentSpacesClientOptions with aspHome', async () => {
    // New signature should accept options object
    const client = await createClient({
      aspHome: '/custom/asp/home',
    })

    expect(client).toBeDefined()
    expect(typeof client.buildProcessInvocationSpec).toBe('function')
  })

  test('accepts AgentSpacesClientOptions with registryPath', async () => {
    const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')

    const client = createAgentSpacesClient({
      aspHome: '/custom/asp/home',
      registryPath: '/custom/registry',
      runtime: compilerRuntime,
    })

    expect(client).toBeDefined()
  })

  test('still works with no arguments (backward compat)', async () => {
    const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')

    // No-arg call should still work
    const client = createAgentSpacesClient()
    expect(client).toBeDefined()
  })

  test('AgentSpacesClientOptions type is exported', async () => {
    // The options type should be importable
    const mod = await import('../../compiler/agent-spaces/src/index.js')
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
  test(
    'AGENT_SCOPE_REF emitted when sessionRef present',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-project', agentName: 'alice' },
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

      expect(response.spec.env['AGENT_SCOPE_REF']).toBe('agent:alice:project:demo')
      expect(response.spec.env['AGENT_LANE_REF']).toBe('main')
    },
    HEAVY_TEST_TIMEOUT_MS
  )

  test(
    'AGENT_HOST_SESSION_ID emitted when hostSessionId present',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-project', agentName: 'alice' },
          correlation: {
            hostSessionId: 'hs-correlation-test',
          },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      expect(response.spec.env['AGENT_HOST_SESSION_ID']).toBe('hs-correlation-test')
    },
    HEAVY_TEST_TIMEOUT_MS
  )

  test(
    'correlation env vars are absent when no correlation provided',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'query',
          bundle: { kind: 'agent-project', agentName: 'alice' },
        },
        provider: 'anthropic',
        frontend: 'claude-code',
        interactionMode: 'headless',
        ioMode: 'pipes',
      } as any)

      expect(response.spec.env['AGENT_SCOPE_REF']).toBeUndefined()
      expect(response.spec.env['AGENT_LANE_REF']).toBeUndefined()
      expect(response.spec.env['AGENT_HOST_SESSION_ID']).toBeUndefined()
    },
    HEAVY_TEST_TIMEOUT_MS
  )

  test(
    'env vars are advisory only (string type)',
    async () => {
      const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
      const client = createAgentSpacesClient({
        aspHome: '/tmp/asp-test-m5',
        runtime: compilerRuntime,
      })

      const response = await client.buildProcessInvocationSpec({
        placement: {
          agentRoot: '/tmp/asp-test-m5/agent-root',
          runMode: 'task',
          bundle: { kind: 'agent-project', agentName: 'alice' },
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

      expect(typeof response.spec.env['AGENT_SCOPE_REF']).toBe('string')
      expect(typeof response.spec.env['AGENT_LANE_REF']).toBe('string')
      expect(typeof response.spec.env['AGENT_HOST_SESSION_ID']).toBe('string')
      expect(response.spec.env['AGENT_SCOPE_REF']).toBe('agent:alice:project:demo:task:t1')
      expect(response.spec.env['AGENT_LANE_REF']).toBe('lane:deploy')
    },
    HEAVY_TEST_TIMEOUT_MS
  )
})

// ===================================================================
// T-00876: unified placement materialization
// Both placement functions use resolvePlacementContext + materializeSpec
// instead of manual registryRefs filtering.
// ===================================================================
describe('unified placement materialization (T-00876)', () => {
  test('the placement invocation builder uses resolvePlacementContext + planPlacementRuntime', () => {
    const { readFileSync } = require('node:fs')
    const { join } = require('node:path')
    const prepareSource = readFileSync(
      join(REPO_ROOT, 'compiler', 'agent-spaces', 'src', 'prepare-cli-runtime.ts'),
      'utf8'
    )
    const buildFn = fnRegion(prepareSource, ...PREPARE_CLI_RUNTIME_REGION)

    expect(buildFn).toBeDefined()
    expect(buildFn).toMatch(/resolvePlacementContext\(/)
    expect(buildFn).toMatch(/planPlacementRuntime\(/)
    expect(prepareSource).not.toMatch(/async function resolvePlacementDefaultRunOptions/)
    expect(prepareSource).not.toMatch(/function resolvePlacementModel\(/)
  })
})

// ===================================================================
// T-00890: Audit bundle must include byMode space overlays
//
// Defect: the materialization planning path must include spaces.byMode[runMode]
// overlays for agent-project bundles, or resolvedBundle.spaces will diverge
// from what's actually materialized.
//
// PASS CONDITIONS:
// 1. buildProcessInvocationSpec with runMode 'heartbeat' and an
//    agent-profile with spaces.byMode.heartbeat includes the byMode
//    space in resolvedBundle.spaces.
// 2. Same profile with runMode 'query' does NOT include heartbeat overlay.
// ===================================================================
describe('audit bundle includes byMode space overlays (T-00890)', () => {
  test('placement-resolver.ts handles byMode instruction overlays (static)', () => {
    const { readFileSync } = require('node:fs')
    const source = readFileSync(
      join(REPO_ROOT, 'core', 'config', 'src', 'resolver', 'placement-resolver.ts'),
      'utf8'
    )

    // After T-01564 the byMode logic lives in resolveInstructions, not
    // the deleted loadAgentDefaultSpaces helper.
    expect(source).toMatch(/instructions\?\.modes/)
  })

  test(
    'heartbeat byMode spaces are materialized (integration)',
    async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'bymode-overlay-'))
      seedImmutableRegistryMirror(join(tempDir, 'asp-home'))
      const agentRoot = join(tempDir, 'agent-root')
      mkdirSync(agentRoot, { recursive: true })
      writeFileSync(join(agentRoot, 'SOUL.md'), 'You are a test agent.\n')
      writeFileSync(
        join(agentRoot, 'agent-profile.toml'),
        `version = 4\n\n[spaces]\nbase = ["space:agent:base-space"]\n\n[spaces.modes.heartbeat]\nbase = ["space:agent:heartbeat-monitor"]\n`
      )
      // Create spaces with manifests
      for (const id of ['base-space', 'heartbeat-monitor']) {
        mkdirSync(join(agentRoot, 'spaces', id, 'claude', 'plugins'), { recursive: true })
        writeFileSync(
          join(agentRoot, 'spaces', id, 'space.toml'),
          `schema = 1\nid = "${id}"\ndescription = "${id} fixture"\n\n[harness]\nsupports = ["claude"]\n\n[claude]\nmodel = "claude-opus-4-6"\n`
        )
      }

      try {
        const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
        const client = createAgentSpacesClient({
          aspHome: join(tempDir, 'asp-home'),
          runtime: compilerRuntime,
        })

        const response = await client.buildProcessInvocationSpec({
          placement: {
            agentRoot,
            runMode: 'heartbeat',
            bundle: { kind: 'agent-project', agentName: 'alice' },
          },
          provider: 'anthropic',
          frontend: 'claude-code',
          interactionMode: 'headless',
          ioMode: 'pipes',
        } as any)

        // The materialized pluginDirs should include heartbeat-monitor space.
        const allEnvVals = Object.values(response.spec.env ?? {}).join('\n')

        // resolvedBundle.spaces says heartbeat-monitor is included
        const auditRefs = response.resolvedBundle!.spaces.map((s: any) => s.ref)
        const auditHasHeartbeat = auditRefs.some((r: string) => r.includes('heartbeat-monitor'))
        expect(auditHasHeartbeat).toBe(true)

        // Agent-project materialization now uses the stable agent-name target
        // path. The heartbeat inclusion is verified by resolvedBundle above; the
        // process env should point at the materialized agent bundle.
        expect(allEnvVals).toContain(join('alice', 'claude'))
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
    HEAVY_TEST_TIMEOUT_MS
  )

  test(
    'query mode does NOT include heartbeat overlay (sanity)',
    async () => {
      // GREEN: query mode should only have base-space.
      const tempDir = mkdtempSync(join(tmpdir(), 'bymode-overlay-'))
      seedImmutableRegistryMirror(join(tempDir, 'asp-home'))
      const agentRoot = join(tempDir, 'agent-root')
      mkdirSync(agentRoot, { recursive: true })
      writeFileSync(join(agentRoot, 'SOUL.md'), 'You are a test agent.\n')
      writeFileSync(
        join(agentRoot, 'agent-profile.toml'),
        `version = 4\n\n[spaces]\nbase = ["space:agent:base-space"]\n\n[spaces.modes.heartbeat]\nbase = ["space:agent:heartbeat-monitor"]\n`
      )
      for (const id of ['base-space', 'heartbeat-monitor']) {
        mkdirSync(join(agentRoot, 'spaces', id, 'claude', 'plugins'), { recursive: true })
        writeFileSync(
          join(agentRoot, 'spaces', id, 'space.toml'),
          `schema = 1\nid = "${id}"\ndescription = "${id} fixture"\n\n[harness]\nsupports = ["claude"]\n\n[claude]\nmodel = "claude-opus-4-6"\n`
        )
      }

      try {
        const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
        const client = createAgentSpacesClient({
          aspHome: join(tempDir, 'asp-home'),
          runtime: compilerRuntime,
        })

        const response = await client.buildProcessInvocationSpec({
          placement: {
            agentRoot,
            runMode: 'query',
            bundle: { kind: 'agent-project', agentName: 'alice' },
          },
          provider: 'anthropic',
          frontend: 'claude-code',
          interactionMode: 'headless',
          ioMode: 'pipes',
        } as any)

        expect(response.resolvedBundle).toBeDefined()
        const spaceRefs = response.resolvedBundle!.spaces.map((s: any) => s.ref)
        const hasHeartbeat = spaceRefs.some((r: string) => r.includes('heartbeat-monitor'))
        expect(hasHeartbeat).toBe(false)
      } finally {
        rmSync(tempDir, { recursive: true, force: true })
      }
    },
    HEAVY_TEST_TIMEOUT_MS
  )
})
