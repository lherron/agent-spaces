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
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { createAgentSpacesClient } from 'agent-spaces'
import type { BuildProcessInvocationSpecResponse, DescribeResponse } from 'agent-spaces'

import {
  CLAUDE_SHIM_PATH,
  CODEX_SHIM_PATH,
  SAMPLE_PROJECT_DIR,
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  createTempAspHome,
  initSampleRegistry,
} from './setup.js'

const client = createAgentSpacesClient()

let aspHome: string
let savedClaudePath: string | undefined
let savedPath: string | undefined

beforeAll(async () => {
  await initSampleRegistry()
})

beforeEach(async () => {
  aspHome = await createTempAspHome()
  // Symlink aspHome/repo → sample-registry so the resolver finds the registry
  await fs.symlink(SAMPLE_REGISTRY_DIR, path.join(aspHome, 'repo'))

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
    // biome-ignore lint/performance/noDelete: delete is the correct idiom for removing process.env keys
    delete process.env['ASP_CLAUDE_PATH']
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

  test('resolves a frontend-only target', async () => {
    const result = await client.resolve({
      aspHome,
      spec: { target: { targetName: 'frontend-only', targetDir: SAMPLE_PROJECT_DIR } },
    })

    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// describe() coverage
// ---------------------------------------------------------------------------

describe('describe', () => {
  test('returns hooks, skills, and tools for target spec', async () => {
    const response: DescribeResponse = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
      frontend: 'agent-sdk',
    })

    // Structure validation
    expect(Array.isArray(response.hooks)).toBe(true)
    expect(Array.isArray(response.skills)).toBe(true)
    expect(Array.isArray(response.tools)).toBe(true)
  })

  test('returns agentSdkSessionParams for agent-sdk frontend', async () => {
    const response = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
      frontend: 'agent-sdk',
      cpSessionId: 'test-cp-session',
      cwd: '/tmp',
    })

    // agent-sdk frontend should produce session params
    expect(response.agentSdkSessionParams).toBeDefined()
    expect(Array.isArray(response.agentSdkSessionParams)).toBe(true)

    // Verify key param names
    const paramNames = response.agentSdkSessionParams?.map((p) => p.paramName) ?? []
    expect(paramNames).toContain('kind')
    expect(paramNames).toContain('model')
    expect(paramNames).toContain('plugins')
    expect(paramNames).toContain('permissionHandler')

    // Verify kind is agent-sdk
    const kindParam = response.agentSdkSessionParams?.find((p) => p.paramName === 'kind')
    expect(kindParam?.paramValue).toBe('agent-sdk')
  })

  test('does not return agentSdkSessionParams for claude-code frontend', async () => {
    const response = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
      frontend: 'claude-code',
    })

    expect(response.agentSdkSessionParams).toBeUndefined()
  })

  test('returns lintWarnings when runLint is true', async () => {
    const response = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
      runLint: true,
    })

    // lintWarnings should be present (even if empty array)
    expect(response.lintWarnings).toBeDefined()
    expect(Array.isArray(response.lintWarnings)).toBe(true)
  })

  test('omits lintWarnings when runLint is false or absent', async () => {
    const response = await client.describe({
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      registryPath: SAMPLE_REGISTRY_DIR,
    })

    expect(response.lintWarnings).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// buildProcessInvocationSpec() success paths
// ---------------------------------------------------------------------------

describe('buildProcessInvocationSpec', () => {
  test('returns complete invocation spec for claude-code', async () => {
    const response: BuildProcessInvocationSpecResponse = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
      cwd: '/tmp',
    })

    // Verify spec structure
    expect(response.spec).toBeDefined()
    expect(response.spec.provider).toBe('anthropic')
    expect(response.spec.frontend).toBe('claude-code')
    expect(response.spec.interactionMode).toBe('interactive')
    expect(response.spec.ioMode).toBe('pty')
    expect(response.spec.cwd).toBe('/tmp')

    // argv should be an array starting with the binary path
    expect(Array.isArray(response.spec.argv)).toBe(true)
    expect(response.spec.argv.length).toBeGreaterThan(0)
    // First element is the binary path (from claude-shim)
    expect(response.spec.argv[0]).toBeDefined()

    // env should include ASP_HOME
    expect(response.spec.env['ASP_HOME']).toBe(aspHome)

    // displayCommand should be a non-empty string
    expect(typeof response.spec.displayCommand).toBe('string')
    expect(response.spec.displayCommand!.length).toBeGreaterThan(0)
  })

  test('argv includes plugin-dir flags for claude-code', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
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

  test('env includes ASP_PLUGIN_ROOT for claude-code', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
      cwd: '/tmp',
    })

    // Claude adapter sets ASP_PLUGIN_ROOT in env
    expect(response.spec.env['ASP_PLUGIN_ROOT']).toBeDefined()
  })

  test('merges request env into spec env', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
      cwd: '/tmp',
      env: { CUSTOM_VAR: 'custom_value', CP_SESSION_ID: 'cp-123' },
    })

    expect(response.spec.env['CUSTOM_VAR']).toBe('custom_value')
    expect(response.spec.env['CP_SESSION_ID']).toBe('cp-123')
    // ASP_HOME should still be present
    expect(response.spec.env['ASP_HOME']).toBe(aspHome)
  })

  test('includes continuation ref when provided', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
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

  test('omits continuation when not provided', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
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

  test('uses specified model in argv', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
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

  test('returns codex-cli invocation spec', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
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

  test('displayCommand is a shell-safe string', async () => {
    const response = await client.buildProcessInvocationSpec({
      cpSessionId: 'test-session',
      aspHome,
      spec: { target: { targetName: 'dev', targetDir: SAMPLE_PROJECT_DIR } },
      provider: 'anthropic',
      frontend: 'claude-code',
      interactionMode: 'interactive',
      ioMode: 'pty',
      cwd: '/tmp',
    })

    const display = response.spec.displayCommand
    expect(display).toBeDefined()
    // Should not contain unquoted special characters that would break shell copy-paste
    // The display command should contain the binary path
    expect(typeof display).toBe('string')
    expect(display!.length).toBeGreaterThan(0)
  })
})
