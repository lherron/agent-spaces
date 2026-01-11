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

import { readLockJson } from '@agent-spaces/core'
import { runGlobalSpace, runLocalSpace } from '@agent-spaces/engine'
import { PathResolver } from '@agent-spaces/store'

import {
  CLAUDE_SHIM_PATH,
  SAMPLE_REGISTRY_DIR,
  cleanupShimOutput,
  cleanupTempAspHome,
  createTempAspHome,
  initSampleRegistry,
  readShimOutput,
} from './setup.js'

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
    process.env.ASP_HOME = aspHome
    process.env.ASP_CLAUDE_PATH = CLAUDE_SHIM_PATH
    process.env.CLAUDE_SHIM_OUTPUT = '/tmp/claude-shim-output.json'
    process.env.CLAUDE_SHIM_VALIDATE_PLUGINS = '1'
  })

  afterEach(async () => {
    // Restore environment
    process.env = originalEnv

    // Cleanup
    await cleanupTempAspHome(aspHome)
    await cleanupShimOutput()
  })

  describe('runGlobalSpace', () => {
    test('runs space reference without a project', async () => {
      const result = await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
        cleanup: false,
        printWarnings: false,
      })

      expect(result.exitCode).toBe(0)
      expect(result.build.pluginDirs.length).toBeGreaterThan(0)

      // Verify plugin directory exists
      const pluginDir = result.build.pluginDirs[0]
      expect(pluginDir).toBeDefined()
      const pluginJsonExists = await fs
        .access(path.join(pluginDir!, '.claude-plugin', 'plugin.json'))
        .then(() => true)
        .catch(() => false)
      expect(pluginJsonExists).toBe(true)
    })

    test('creates global lock file at $ASP_HOME/global-lock.json', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
        printWarnings: false,
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
      expect(Object.keys(lock.spaces).length).toBeGreaterThan(0)
      expect(lock.targets['_global']).toBeDefined()
    })

    test('merges with existing global lock file', async () => {
      // First run with one space
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
        printWarnings: false,
      })

      const paths = new PathResolver({ aspHome })
      const lockAfterFirst = await readLockJson(paths.globalLock)
      const spacesAfterFirst = Object.keys(lockAfterFirst.spaces).length

      // Second run with a different space
      await runGlobalSpace('space:frontend@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
        printWarnings: false,
      })

      const lockAfterSecond = await readLockJson(paths.globalLock)
      // Should have more spaces after second run (frontend + base dependency)
      expect(Object.keys(lockAfterSecond.spaces).length).toBeGreaterThanOrEqual(spacesAfterFirst)
    })

    test('includes dependencies in global mode run', async () => {
      // Frontend depends on base
      const result = await runGlobalSpace('space:frontend@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test prompt',
        cleanup: false,
        printWarnings: false,
      })

      // Should have at least 2 plugin dirs (frontend + base)
      expect(result.build.pluginDirs.length).toBeGreaterThanOrEqual(2)
    })

    test('passes plugin directories to Claude', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test global',
        printWarnings: false,
      })

      const shimOutput = await readShimOutput()
      expect(shimOutput.pluginDirs.length).toBeGreaterThan(0)
      expect(shimOutput.args).toContain('--print')
      expect(shimOutput.args).toContain('test global')
    })

    test('passes extra args to Claude', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test',
        extraArgs: ['--model', 'claude-3-5-sonnet-20241022'],
        printWarnings: false,
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

    test('runs local space in dev mode', async () => {
      const result = await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test dev mode',
        cleanup: false,
        printWarnings: false,
      })

      expect(result.exitCode).toBe(0)
      expect(result.build.pluginDirs.length).toBe(1)

      // Verify plugin directory exists
      const pluginDir = result.build.pluginDirs[0]
      expect(pluginDir).toBeDefined()
      const pluginJsonExists = await fs
        .access(path.join(pluginDir!, '.claude-plugin', 'plugin.json'))
        .then(() => true)
        .catch(() => false)
      expect(pluginJsonExists).toBe(true)
    })

    test('does not create global lock for dev mode runs', async () => {
      await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test dev mode',
        printWarnings: false,
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
      await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test dev',
        printWarnings: false,
      })

      const shimOutput = await readShimOutput()
      expect(shimOutput.pluginDirs.length).toBe(1)
      expect(shimOutput.args).toContain('--print')
      expect(shimOutput.args).toContain('test dev')
    })

    test('materializes components from local space', async () => {
      const result = await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test',
        cleanup: false,
        printWarnings: false,
      })

      // Verify commands directory was materialized
      const pluginDir = result.build.pluginDirs[0]!
      const commandsExists = await fs
        .access(path.join(pluginDir, 'commands'))
        .then(() => true)
        .catch(() => false)
      expect(commandsExists).toBe(true)
    })

    test('uses local path as working directory by default', async () => {
      await runLocalSpace(localSpacePath, {
        aspHome,
        interactive: false,
        prompt: 'test cwd',
        printWarnings: false,
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
          printWarnings: false,
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

  describe('global lock file behavior', () => {
    test('lock file has correct structure', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test',
        printWarnings: false,
      })

      const paths = new PathResolver({ aspHome })
      const lock = await readLockJson(paths.globalLock)

      expect(lock.lockfileVersion).toBe(1)
      expect(lock.resolverVersion).toBe(1)
      expect(lock.generatedAt).toBeDefined()
      expect(lock.registry).toBeDefined()
      expect(lock.registry.type).toBe('git')
      expect(lock.spaces).toBeDefined()
      expect(lock.targets).toBeDefined()
      expect(lock.targets['_global']).toBeDefined()
    })

    test('lock file contains space integrity hash', async () => {
      await runGlobalSpace('space:base@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test',
        printWarnings: false,
      })

      const paths = new PathResolver({ aspHome })
      const lock = await readLockJson(paths.globalLock)

      // At least one space should have an integrity hash
      const spaceEntries = Object.values(lock.spaces)
      expect(spaceEntries.length).toBeGreaterThan(0)

      const firstSpace = spaceEntries[0]
      expect(firstSpace?.integrity).toBeDefined()
      expect(firstSpace?.integrity).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    test('lock file loadOrder includes dependencies first', async () => {
      // Frontend depends on base
      await runGlobalSpace('space:frontend@stable', {
        aspHome,
        registryPath: SAMPLE_REGISTRY_DIR,
        interactive: false,
        prompt: 'test',
        printWarnings: false,
      })

      const paths = new PathResolver({ aspHome })
      const lock = await readLockJson(paths.globalLock)

      const loadOrder = lock.targets['_global']?.loadOrder ?? []
      expect(loadOrder.length).toBeGreaterThanOrEqual(2)

      // Find base and frontend indices
      const baseIdx = loadOrder.findIndex((k) => k.startsWith('base@'))
      const frontendIdx = loadOrder.findIndex((k) => k.startsWith('frontend@'))

      // Base should come before frontend (deps before dependents)
      expect(baseIdx).toBeLessThan(frontendIdx)
    })
  })
})
