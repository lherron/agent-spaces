/**
 * Integration tests for `asp run` command.
 *
 * WHY: The run command is the primary user-facing command. It resolves
 * a target, materializes plugins, and launches Claude with the correct
 * --plugin-dir flags. We use a claude shim to validate the invocation
 * without actually running Claude.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { install, run, runWithPrompt } from 'spaces-execution'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupShimOutput,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  getTestEnv,
  initSampleRegistry,
  readShimOutput,
} from './setup.js'

describe('asp run', () => {
  let aspHome: string
  let projectDir: string
  let originalEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    await initSampleRegistry()
  })

  afterAll(async () => {
    // Note: Don't clean up sample registry - other parallel tests may need it
  })

  beforeEach(async () => {
    // Save original env
    originalEnv = { ...process.env }

    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })

    // Install first
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Clean up any previous shim output
    await cleanupShimOutput()

    // Set up environment for claude shim
    const testEnv = getTestEnv(aspHome)
    for (const [key, value] of Object.entries(testEnv)) {
      process.env[key] = value
    }
  })

  afterEach(async () => {
    // Restore original env
    process.env = originalEnv

    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
    await cleanupShimOutput()
  })

  test('invokes claude with correct plugin directories', async () => {
    const result = await runWithPrompt('dev', 'Hello, Claude!', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.exitCode).toBe(0)

    // Read shim output to verify invocation
    const shimOutput = await readShimOutput()

    // Should have plugin dirs
    expect(shimOutput.pluginDirs.length).toBeGreaterThan(0)

    // Each plugin dir should exist and have plugin.json
    for (const dir of shimOutput.pluginDirs) {
      const exists = await fs
        .access(dir)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)

      const pluginJson = path.join(dir, '.claude-plugin', 'plugin.json')
      const hasPluginJson = await fs
        .access(pluginJson)
        .then(() => true)
        .catch(() => false)
      expect(hasPluginJson).toBe(true)
    }
  })

  test('passes prompt via --print flag', async () => {
    const prompt = 'Tell me about testing'

    await runWithPrompt('dev', prompt, {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const shimOutput = await readShimOutput()

    // Should have -p flag with prompt
    const pIndex = shimOutput.args.indexOf('-p')
    expect(pIndex).toBeGreaterThanOrEqual(0)
    expect(shimOutput.args[pIndex + 1]).toBe(prompt)
  })

  test('loads plugins in correct order (deps before dependents)', async () => {
    await runWithPrompt('dev', 'test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const shimOutput = await readShimOutput()

    // Extract plugin names from paths
    const pluginNames: string[] = []
    for (const dir of shimOutput.pluginDirs) {
      const pluginJsonPath = path.join(dir, '.claude-plugin', 'plugin.json')
      const content = await fs.readFile(pluginJsonPath, 'utf-8')
      const pluginJson = JSON.parse(content)
      pluginNames.push(pluginJson.name)
    }

    // Base should come before frontend (base is a dep of frontend)
    const baseIndex = pluginNames.indexOf('base')
    const frontendIndex = pluginNames.indexOf('frontend')

    expect(baseIndex).toBeGreaterThanOrEqual(0)
    expect(frontendIndex).toBeGreaterThan(baseIndex)
  })

  test('handles single space target', async () => {
    // Create project with single target
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      single: {
        compose: ['space:base@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await runWithPrompt('single', 'test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.exitCode).toBe(0)

    const shimOutput = await readShimOutput()
    expect(shimOutput.pluginDirs.length).toBe(1)
  })

  test('exits with claude exit code', async () => {
    // Pass CLAUDE_SHIM_EXIT_CODE through env option
    const result = await runWithPrompt('dev', 'test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      env: { CLAUDE_SHIM_EXIT_CODE: '42' },
    })

    expect(result.exitCode).toBe(42)
  })

  test('dry-run does not invoke Claude', async () => {
    // Clean up any previous shim output to ensure we detect no invocation
    await cleanupShimOutput()

    const result = await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      dryRun: true,
    })

    expect(result.exitCode).toBe(0)
    expect(result.command).toBeDefined()

    // Shim output file should NOT exist because Claude was not invoked
    const shimExists = await fs
      .access('/tmp/claude-shim-output.json')
      .then(() => true)
      .catch(() => false)
    expect(shimExists).toBe(false)
  })

  test('dry-run returns command with plugin dirs', async () => {
    const result = await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      dryRun: true,
    })

    expect(result.command).toBeDefined()
    expect(result.command).toContain('--plugin-dir')
  })

  test('dry-run includes prompt in command', async () => {
    const prompt = 'Hello, Claude!'

    await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      prompt,
    })

    const shimOutput = await readShimOutput()
    expect(shimOutput.args).not.toContain('-p')
    expect(shimOutput.args).toContain(prompt)
  })

  test('non-interactive mode uses print prompt mode', async () => {
    const prompt = 'Hello, Claude!'

    await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      interactive: false,
      prompt,
    })

    const shimOutput = await readShimOutput()
    const pIndex = shimOutput.args.indexOf('-p')
    expect(pIndex).toBeGreaterThanOrEqual(0)
    expect(shimOutput.args[pIndex + 1]).toBe(prompt)
  })

  test('concatenates priming_prompt and user prompt with blank line', async () => {
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        priming_prompt: 'Register with agentchat and send READY',
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      dryRun: true,
      prompt: 'Investigate failing tests',
    })

    expect(result.command).toBeDefined()
    expect(result.command).toContain(
      'Register with agentchat and send READY\n\nInvestigate failing tests'
    )
  })

  test('dry-run includes prompt in command when non-interactive', async () => {
    const result = await run('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      dryRun: true,
      interactive: false,
      prompt: 'Hello, Claude!',
    })

    expect(result.command).toBeDefined()
    expect(result.command).toContain('-p')
    expect(result.command).toContain('Hello, Claude!')
  })
})
