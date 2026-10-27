/**
 * Integration tests for the agent-spaces client public API.
 *
 * WHY: The agent-spaces client (resolve, describe, buildProcessInvocationSpec,
 * runTurnNonInteractive, getHarnessCapabilities) is the primary programmatic
 * interface for the control plane. These tests exercise the success paths that
 * require real fixtures — registry resolution, materialization, and harness
 * adapter integration — which cannot be tested in unit tests without a registry.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as path from 'node:path'

import { createAgentSpacesClient } from 'agent-spaces'
import { compilerRuntime } from './compiler-runtime.js'

import {
  CLAUDE_SHIM_PATH,
  CODEX_SHIM_PATH,
  SAMPLE_PROJECT_DIR,
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  createTempAspHome,
  initSampleRegistry,
} from './setup.js'

// `registryPath` is the client-level surface for pointing resolution at a local
// registry with no remote -- the same thing `asp --registry <path>` exposes on nine
// CLI commands. The suite previously symlinked `<aspHome>/repo` at the fixture
// instead, which `getRegistryPath` stopped consulting once the agents root became
// the default shared-space source: it only falls back to `paths.repo` when
// `getAgentsRoot()` is empty, which it never is on a praesidium node.
const client = createAgentSpacesClient({
  runtime: compilerRuntime,
  registryPath: SAMPLE_REGISTRY_DIR,
})

let aspHome: string
let savedClaudePath: string | undefined
let savedPath: string | undefined

beforeAll(async () => {
  await initSampleRegistry()
})

beforeEach(async () => {
  aspHome = await createTempAspHome()

  // Save and set env for harness detection
  savedClaudePath = process.env['ASP_CLAUDE_PATH']
  savedPath = process.env['PATH']
  process.env['ASP_CLAUDE_PATH'] = CLAUDE_SHIM_PATH
  const codexShimDir = path.dirname(CODEX_SHIM_PATH)
  process.env['PATH'] = [codexShimDir, savedPath ?? ''].filter(Boolean).join(path.delimiter)
})

afterEach(async () => {
  // Restore env
  if (savedClaudePath !== undefined) {
    process.env['ASP_CLAUDE_PATH'] = savedClaudePath
  } else {
    Reflect.deleteProperty(process.env, 'ASP_CLAUDE_PATH')
  }
  if (savedPath !== undefined) {
    process.env['PATH'] = savedPath
  }
  await cleanupTempAspHome(aspHome)
})

// ---------------------------------------------------------------------------
// resolve() success paths
// ---------------------------------------------------------------------------

describe('resolve success paths', () => {
  test('resolves a target spec pointing to sample-project', async () => {
    const result = await client.resolve({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
    })

    expect(result.ok).toBe(true)
    expect(result.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// describe() coverage
// ---------------------------------------------------------------------------

describe('describe', () => {
  test('rejects the retired frontend selector at runtime', async () => {
    await expect(
      client.describe({
        aspHome,
        spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
        registryPath: SAMPLE_REGISTRY_DIR,
        frontend: 'agent-sdk',
      } as never)
    ).rejects.toMatchObject({ code: 'unsupported_frontend' })
  })

  test('omits lintWarnings when runLint is false or absent', async () => {
    const response = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
      harness: 'claude',
    })

    expect(response.lintWarnings).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildProcessInvocationSpec() success paths
// ---------------------------------------------------------------------------

// No 'merges request env into spec env' case: `BuildProcessInvocationSpecRequest.env`
// was a deprecated alias for `lockedEnv` and T-04600 (64d5f9c, 2026-06-21) deleted it
// along with `cpSessionId`. The test outlived the contract it asserted and only ever
// passed an excess property. The surviving `lockedEnv`/`dispatchEnv` are composed by
// the `placement` branch, not this legacy one, which has no production caller (HRC's
// cli-adapter always supplies `placement`) -- see T-07694.
describe('buildProcessInvocationSpec', () => {
  test('argv includes plugin-dir flags for claude-code', async () => {
    const response = await client.buildProcessInvocationSpec({
      hostSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'headless',
      ioMode: 'pipes',
      cwd: '/tmp',
    })

    // The claude adapter should include --plugin-dir flags for each plugin directory
    const argv = response.spec.argv
    expect(argv.some((arg) => arg === '--plugin-dir')).toBe(true)
  })

  test('includes continuation ref when provided', async () => {
    const response = await client.buildProcessInvocationSpec({
      hostSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
      continuation: { provider: 'anthropic', key: 'session-key-abc' },
      cwd: '/tmp',
    })

    expect(response.spec.continuation).toBeDefined()
    expect(response.spec.continuation?.provider).toBe('anthropic')
    expect(response.spec.continuation?.key).toBe('session-key-abc')

    // argv should include resume flag
    const argv = response.spec.argv
    expect(argv.some((arg) => arg === '--resume' || arg === 'resume')).toBe(true)
  })

  test('uses specified model in argv', async () => {
    const response = await client.buildProcessInvocationSpec({
      hostSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      model: 'claude-sonnet-4-5',
      interactionMode: 'interactive',
      ioMode: 'pty',
      cwd: '/tmp',
    })

    // argv should include model flag
    const argv = response.spec.argv
    const modelIdx = argv.indexOf('--model')
    expect(modelIdx).toBeGreaterThan(-1)
    expect(argv[modelIdx + 1]).toBe('claude-sonnet-4-5')
  })
})

test('omits continuation when not provided', async () => {
  const response = await client.buildProcessInvocationSpec({
    hostSessionId: 'test-session',
    aspHome,
    spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
    provider: 'anthropic',
    frontend: 'claude-code',
    interactionMode: 'interactive',
    ioMode: 'pty',
    cwd: '/tmp',
  })

  expect(response.spec.continuation).toBeUndefined()
})

test('returns codex-cli invocation spec', async () => {
  const response = await client.buildProcessInvocationSpec({
    hostSessionId: 'test-session',
    aspHome,
    spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
    provider: 'openai',
    frontend: 'codex-cli',
    interactionMode: 'headless',
    ioMode: 'pipes',
    cwd: '/tmp',
  })

  expect(response.spec.provider).toBe('openai')
  expect(response.spec.frontend).toBe('codex-cli')
  expect(response.spec.interactionMode).toBe('headless')
  expect(response.spec.ioMode).toBe('pipes')
  expect(response.spec.cwd).toBe('/tmp')
  expect(response.spec.argv.length).toBeGreaterThan(0)
  expect(response.spec.env['ASP_HOME']).toBe(aspHome)
})
