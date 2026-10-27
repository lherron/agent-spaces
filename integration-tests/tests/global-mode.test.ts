/**
 * Integration tests for global mode (running spaces outside projects).
 *
 * WHY: Global mode allows running spaces without a project context using
 * `asp run space:id@selector` or `asp run ./local-space`. These tests verify:
 * 1. Space references resolve and run correctly outside projects
 * 2. Global lock file is created and persisted at $ASP_HOME/global-lock.json
 * 3. Dev mode runs work with local space paths
 * 4. Dependencies are included in global mode runs
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { PathResolver, readLockJson } from 'spaces-config'
import {
  harnessRegistry,
  runGlobalSpace as runGlobalSpaceExecution,
  runLocalSpace as runLocalSpaceExecution,
} from 'spaces-execution'

import {
  CLAUDE_SHIM_PATH,
  SAMPLE_REGISTRY_DIR,
  SHIM_OUTPUT_FILE,
  cleanupShimOutput,
  cleanupTempAspHome,
  createTempAspHome,
  initSampleRegistry,
  readShimOutput,
} from './setup.js'

const CLAUDE_EXECUTION = {
  harnessId: 'claude' as const,
  adapter: harnessRegistry.getOrThrow('claude'),
}

function runGlobalSpace(
  spaceRef: Parameters<typeof runGlobalSpaceExecution>[0],
  options: Omit<Parameters<typeof runGlobalSpaceExecution>[1], 'execution'>
): ReturnType<typeof runGlobalSpaceExecution> {
  return runGlobalSpaceExecution(spaceRef, { ...options, execution: CLAUDE_EXECUTION })
}

function runLocalSpace(
  spacePath: string,
  options: Omit<Parameters<typeof runLocalSpaceExecution>[1], 'execution'>
): ReturnType<typeof runLocalSpaceExecution> {
  return runLocalSpaceExecution(spacePath, { ...options, execution: CLAUDE_EXECUTION })
}

describe('asp run global mode', () => {
  let aspHome: string
  let originalEnv: NodeJS.ProcessEnv

  beforeAll(async () => {
    // Initialize sample registry with git tags
    await initSampleRegistry()
  })

  beforeEach(async () => {
    // Save environment
    originalEnv = { ...process.env }

    // Create temp ASP_HOME
    aspHome = await createTempAspHome()

    // Clean up any previous shim output
    await cleanupShimOutput()

    // Set environment for claude shim
    process.env['ASP_HOME'] = aspHome
    process.env['ASP_CLAUDE_PATH'] = CLAUDE_SHIM_PATH
    process.env['CLAUDE_SHIM_OUTPUT'] = SHIM_OUTPUT_FILE
    process.env['CLAUDE_SHIM_VALIDATE_PLUGINS'] = '1'
  })

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv

    // Cleanup
    await cleanupTempAspHome(aspHome)
    await cleanupShimOutput()
  })

  describe('runGlobalSpace', () => {
    test('creates global lock file at $ASP_HOME/global-lock.json', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
      })

      const paths = new PathResolver({ aspHome })
      const globalLockExists = await fs
        .access(paths.globalLock)
        .then(() => true)
        .catch(() => false)
      expect(globalLockExists).toBe(true)

      // Verify lock file content
      const lock = await readLockJson(paths.globalLock)
      expect(lock.lockfileVersion).toBe(1)
      expect(lock.resolverVersion).toBe(1)
      expect(lock.registry.type).toBe('git')
      for (const space of Object.values(lock.spaces))
        expect(space.integrity).toMatch(/^sha256:[a-f0-9]{64}$/)
      expect(Object.keys(lock.spaces).length).toBeGreaterThan(0)
      expect(lock.targets['_global']).toBeDefined()
    })

    test('a second global run preserves a previously locked unrelated space', async () => {
      // First run with one space
      await runGlobalSpace('space:backend@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
      })

      const paths = new PathResolver({ aspHome })
      const lockAfterFirst = await readLockJson(paths.globalLock)
      const backendKey = Object.keys(lockAfterFirst.spaces).find((key) =>
        key.startsWith('backend@')
      )
      expect(backendKey).toBeDefined()

      // Second run with a different space
      await runGlobalSpace('space:frontend@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
      })

      const lockAfterSecond = await readLockJson(paths.globalLock)
      expect(lockAfterSecond.spaces[backendKey as keyof typeof lockAfterSecond.spaces]).toEqual(
        lockAfterFirst.spaces[backendKey as keyof typeof lockAfterFirst.spaces]
      )
    })

    test('passes plugin directories to Claude', async () => {
      const result = await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        cleanup: false,
        prompt: 'test global',
      })

      expect(result.exitCode).toBe(0)
      const shimOutput = await readShimOutput()
      expect(shimOutput.pluginDirs.length).toBeGreaterThan(0)
      for (const pluginDir of shimOutput.pluginDirs) {
        await fs.access(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
      }
      expect(shimOutput.args).toContain('-p')
      expect(shimOutput.args).toContain('test global')
    })

    test('passes extra args to Claude', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test',
        extraArgs: ['--model', 'claude-3-5-sonnet-20241022'],
      })

      const shimOutput = await readShimOutput()
      expect(shimOutput.args).toContain('--model')
      expect(shimOutput.args).toContain('claude-3-5-sonnet-20241022')
    })
  })

  describe('runLocalSpace', () => {
    let localSpacePath: string

    beforeEach(async () => {
      // Create a temporary local space for dev mode testing
      localSpacePath = await fs.mkdtemp('/tmp/asp-local-space-')

      // Write space.toml
      await fs.writeFile(
        path.join(localSpacePath, 'space.toml'),
        `schema = 1\nid = "test-local-space"\ndescription = "A test space for dev mode"\n`
      )

      // Create commands directory
      const commandsDir = path.join(localSpacePath, 'commands')
      await fs.mkdir(commandsDir, { recursive: true })
      await fs.writeFile(path.join(commandsDir, 'hello.md'), '# Hello\nThis is a test command.')
    })

    afterEach(async () => {
      await fs.rm(localSpacePath, { recursive: true, force: true })
    })

    test('does not create global lock for dev mode runs', async () => {
      await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test dev mode',
      })

      const paths = new PathResolver({ aspHome })
      const globalLockExists = await fs
        .access(paths.globalLock)
        .then(() => true)
        .catch(() => false)
      // Dev mode should NOT create global lock
      expect(globalLockExists).toBe(false)
    })

    test('passes plugin directories to Claude', async () => {
      const result = await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        cleanup: false,
        prompt: 'test dev',
      })

      expect(result.exitCode).toBe(0)
      const shimOutput = await readShimOutput()
      expect(shimOutput.pluginDirs.length).toBe(1)
      for (const pluginDir of shimOutput.pluginDirs) {
        await fs.access(path.join(pluginDir, '.claude-plugin', 'plugin.json'))
        await fs.access(path.join(pluginDir, 'commands'))
      }
      expect(shimOutput.args).toContain('-p')
      expect(shimOutput.args).toContain('test dev')
    })

    test('uses local path as working directory by default', async () => {
      await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test cwd',
      })

      const shimOutput = await readShimOutput()
      // Resolve symlinks (macOS /tmp -> /private/tmp)
      const expectedPath = await fs.realpath(localSpacePath)
      expect(shimOutput.workingDir).toBe(expectedPath)
    })

    test('respects cwd override', async () => {
      const customCwd = await fs.mkdtemp('/tmp/asp-custom-cwd-')

      try {
        await runLocalSpace(localSpacePath, {
          aspHome,
          cwd: customCwd,
          interactive: false,
          prompt: 'test cwd override',
        })

        const shimOutput = await readShimOutput()
        // Resolve symlinks (macOS /tmp -> /private/tmp)
        const expectedPath = await fs.realpath(customCwd)
        expect(shimOutput.workingDir).toBe(expectedPath)
      } finally {
        await fs.rm(customCwd, { recursive: true, force: true })
      }
    })
  })

  describe('global lock file behavior', () => {})
})
