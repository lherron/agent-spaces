/**
 * Integration tests for CLI --harness flag and harness management.
 *
 * WHY: The --harness flag allows users to select which coding agent harness
 * (Claude, Pi, etc.) to use. These tests verify:
 * - The `asp harnesses` command correctly lists available harnesses
 * - The --harness flag on run/build/install/explain commands works correctly
 * - Invalid harness IDs produce helpful error messages
 * - Output paths include the harness subdirectory (asp_modules/<target>/<harness>/)
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { exec } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { promisify } from 'node:util'

import { harnessRegistry, install } from 'spaces-engine'

import {
  FIXTURES_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  getTestEnv,
} from './setup.js'

const execAsync = promisify(exec)

/** Path to the multi-harness fixtures */
const MULTI_HARNESS_DIR = path.join(FIXTURES_DIR, 'multi-harness')

/** Path to CLI entry point */
const CLI_PATH = path.join(import.meta.dir, '..', '..', 'packages', 'cli', 'bin', 'asp.js')

/**
 * Run CLI command and capture output.
 */
async function runCli(
  args: string[],
  options: {
    env?: Record<string, string>
    cwd?: string
  } = {}
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const command = `bun ${CLI_PATH} ${args.join(' ')}`
  try {
    const { stdout, stderr } = await execAsync(command, {
      cwd: options.cwd ?? process.cwd(),
      env: { ...process.env, ...options.env },
    })
    return { stdout, stderr, exitCode: 0 }
  } catch (error) {
    // exec throws on non-zero exit
    const e = error as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    }
  }
}

describe('asp harnesses', () => {
  test('lists available harnesses in text format', async () => {
    const { stdout, exitCode } = await runCli(['harnesses'])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Available Harnesses')
    expect(stdout).toContain('claude')
    expect(stdout).toContain('(default)')
  })

  test('lists harnesses in JSON format with --json flag', async () => {
    const { stdout, exitCode } = await runCli(['harnesses', '--json'])

    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    expect(output).toHaveProperty('harnesses')
    expect(output).toHaveProperty('defaultHarness')
    expect(output.defaultHarness).toBe('claude')

    // Should have at least Claude harness
    const claudeHarness = output.harnesses.find((h: { id: string }) => h.id === 'claude')
    expect(claudeHarness).toBeDefined()
    expect(claudeHarness.name).toBe('Claude Code')
    expect(claudeHarness.detection).toHaveProperty('available')
  })

  test('includes Pi harness in registry', async () => {
    const { stdout, exitCode } = await runCli(['harnesses', '--json'])

    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    const piHarness = output.harnesses.find((h: { id: string }) => h.id === 'pi')
    expect(piHarness).toBeDefined()
    expect(piHarness.name).toBe('Pi Coding Agent')
  })

  test('shows detection status for each harness', async () => {
    const { stdout, exitCode } = await runCli(['harnesses', '--json'])

    expect(exitCode).toBe(0)

    const output = JSON.parse(stdout)
    for (const harness of output.harnesses) {
      expect(harness.detection).toHaveProperty('available')
      // If not available, should have error message
      if (!harness.detection.available) {
        expect(harness.detection.error).toBeDefined()
      }
    }
  })
})

describe('asp run --harness', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    // Create project using the multi-harness fixture
    projectDir = await createTempProject({
      'claude-target': {
        description: 'Claude-only target',
        compose: [`space:path:${MULTI_HARNESS_DIR}/claude-only@dev`],
      },
    })

    // Install first
    await install({
      projectPath: projectDir,
      aspHome,
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('--dry-run works with --harness claude', async () => {
    const testEnv = getTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'claude-target', '--harness', 'claude', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Dry run')
    expect(stdout).toContain('Command:')
    // Should have plugin-dir flag pointing to claude subdirectory
    expect(stdout).toContain('--plugin-dir')
    expect(stdout).toContain('claude')
  })

  test('--harness defaults to claude', async () => {
    const testEnv = getTestEnv(aspHome)

    // Run without --harness flag
    const { stdout: withoutFlag, exitCode: exitWithout } = await runCli(
      ['run', 'claude-target', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    // Run with --harness claude
    const { stdout: withFlag, exitCode: exitWith } = await runCli(
      ['run', 'claude-target', '--harness', 'claude', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitWithout).toBe(0)
    expect(exitWith).toBe(0)

    // Both should produce the same command
    // Extract the command lines (after "Command:")
    const commandWithout = withoutFlag.split('Command:')[1]?.trim()
    const commandWith = withFlag.split('Command:')[1]?.trim()
    expect(commandWithout).toEqual(commandWith)
  })

  test('output path includes harness subdirectory', async () => {
    const testEnv = getTestEnv(aspHome)
    const { stdout, exitCode } = await runCli(
      ['run', 'claude-target', '--harness', 'claude', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    // Verify the plugin-dir path contains /claude/ (harness subdirectory)
    const pluginDirMatch = stdout.match(/--plugin-dir\s+(\S+)/)
    if (pluginDirMatch) {
      expect(pluginDirMatch[1]).toContain('/claude/')
    }
  })
})

describe('asp install --harness', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      'test-target': {
        compose: [`space:path:${MULTI_HARNESS_DIR}/claude-only@dev`],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('installs with --harness claude', async () => {
    const { stdout, exitCode } = await runCli(
      ['install', '--harness', 'claude', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Installed')

    // Verify asp_modules/<target>/claude/ directory exists
    const harnessOutputPath = path.join(projectDir, 'asp_modules', 'test-target', 'claude')
    const exists = await fs
      .access(harnessOutputPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })

  test('creates harness-specific output directory structure', async () => {
    await runCli(['install', '--harness', 'claude', '--asp-home', aspHome], { cwd: projectDir })

    const harnessPath = path.join(projectDir, 'asp_modules', 'test-target', 'claude')

    // Should have plugins directory
    const pluginsExists = await fs
      .access(path.join(harnessPath, 'plugins'))
      .then(() => true)
      .catch(() => false)
    expect(pluginsExists).toBe(true)

    // Should have settings.json
    const settingsExists = await fs
      .access(path.join(harnessPath, 'settings.json'))
      .then(() => true)
      .catch(() => false)
    expect(settingsExists).toBe(true)
  })
})

describe('asp explain --harness', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      'explain-target': {
        compose: [`space:path:${MULTI_HARNESS_DIR}/claude-only@dev`],
      },
    })

    await install({
      projectPath: projectDir,
      aspHome,
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('explain accepts --harness flag', async () => {
    const { stdout, exitCode } = await runCli(
      ['explain', 'explain-target', '--harness', 'claude', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    expect(stdout).toContain('explain-target')
  })

  test('explain --json includes harness info', async () => {
    const { stdout, exitCode } = await runCli(
      ['explain', 'explain-target', '--harness', 'claude', '--json', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(0)
    const output = JSON.parse(stdout)
    expect(output).toHaveProperty('targets')
    expect(output.targets).toHaveProperty('explain-target')
  })
})

describe('invalid harness handling', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      target: {
        compose: [`space:path:${MULTI_HARNESS_DIR}/claude-only@dev`],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('run command rejects invalid harness ID', async () => {
    const testEnv = getTestEnv(aspHome)
    const { stderr, exitCode } = await runCli(
      ['run', 'target', '--harness', 'invalid-harness', '--dry-run'],
      { env: testEnv, cwd: projectDir }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown harness')
    expect(stderr).toContain('invalid-harness')
    // Should list available harnesses
    expect(stderr).toContain('claude')
  })

  test('install command rejects invalid harness ID', async () => {
    const { stderr, exitCode } = await runCli(
      ['install', '--harness', 'not-a-harness', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown harness')
    expect(stderr).toContain('not-a-harness')
  })

  test('build command rejects invalid harness ID', async () => {
    const { stderr, exitCode } = await runCli(
      ['build', 'target', '--harness', 'fake', '--output', '/tmp/out', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown harness')
    expect(stderr).toContain('fake')
  })

  test('explain command rejects invalid harness ID', async () => {
    const { stderr, exitCode } = await runCli(
      ['explain', 'target', '--harness', 'nope', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown harness')
    expect(stderr).toContain('nope')
  })

  test('error message lists available harnesses', async () => {
    const { stderr, exitCode } = await runCli(
      ['run', 'target', '--harness', 'wrong', '--asp-home', aspHome],
      { cwd: projectDir }
    )

    expect(exitCode).toBe(1)
    // Should list all registered harnesses
    expect(stderr).toContain('claude')
    expect(stderr).toContain('pi')
  })
})

describe('harness registry', () => {
  test('has claude adapter registered', () => {
    expect(harnessRegistry.has('claude')).toBe(true)
    const claude = harnessRegistry.get('claude')
    expect(claude).toBeDefined()
    expect(claude?.name).toBe('Claude Code')
  })

  test('has pi adapter registered', () => {
    expect(harnessRegistry.has('pi')).toBe(true)
    const pi = harnessRegistry.get('pi')
    expect(pi).toBeDefined()
    expect(pi?.name).toBe('Pi Coding Agent')
  })

  test('getAll returns both adapters', () => {
    const adapters = harnessRegistry.getAll()
    const ids = adapters.map((a) => a.id)
    expect(ids).toContain('claude')
    expect(ids).toContain('pi')
  })
})
