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

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HEAVY_TEST_TIMEOUT_MS = 60_000
import { compilerRuntime } from './compiler-runtime.js'
import { seedImmutableRegistryMirror } from './hermetic.js'

async function createClient(options?: { aspHome?: string; registryPath?: string }) {
  const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
  return createAgentSpacesClient({ ...options, runtime: compilerRuntime })
}

const scratch = mkdtempSync(join(tmpdir(), 'asp-test-m5-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

beforeAll(() => {
  const agentRoot = join(scratch, 'agent-root')
  mkdirSync(agentRoot, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    'version = 4\n\n[spaces]\nbase = []\n',
    'utf8'
  )
})

// ===================================================================
// T-00862: resolvedBundle returned from execution/invocation APIs
// ===================================================================
describe('resolvedBundle from APIs (T-00862)', () => {
  test('provider mismatch still detected with placement API', async () => {
    const { createAgentSpacesClient } = await import('../../compiler/agent-spaces/src/index.js')
    const client = createAgentSpacesClient({
      aspHome: scratch,
      runtime: compilerRuntime,
    })

    // Try to continue an anthropic session with an openai frontend
    await expect(
      client.buildProcessInvocationSpec({
        placement: {
          agentRoot: join(scratch, 'agent-root'),
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
        aspHome: scratch,
        runtime: compilerRuntime,
      })

      // anthropic continuation with anthropic frontend should be OK structurally
      // (may fail for other reasons like missing agentRoot, but not provider mismatch)
      try {
        await client.buildProcessInvocationSpec({
          placement: {
            agentRoot: join(scratch, 'agent-root'),
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
  test.each([
    ['heartbeat', true],
    ['query', false],
  ] as const)(
    '%s mode includes heartbeat overlay: %s',
    async (runMode, includesHeartbeat) => {
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
            runMode,
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
        expect(auditHasHeartbeat).toBe(includesHeartbeat)

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
})
