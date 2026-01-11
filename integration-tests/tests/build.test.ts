/**
 * Integration tests for `asp build` command.
 *
 * WHY: The build command materializes spaces into plugin directories
 * without launching Claude. This is useful for debugging, sharing,
 * and CI validation. We need to verify the materialized structure
 * matches Claude Code plugin requirements.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { build, install } from '@agent-spaces/engine'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

describe('asp build', () => {
  let aspHome: string
  let projectDir: string
  let outputDir: string

  beforeAll(async () => {
    await initSampleRegistry()
  })

  afterAll(async () => {
    // Note: Don't clean up sample registry - other parallel tests may need it
  })

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })
    outputDir = await fs.mkdtemp('/tmp/asp-build-output-')

    // Install first (build requires lock file)
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
    await fs.rm(outputDir, { recursive: true, force: true })
  })

  test('materializes plugin directories', async () => {
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Build succeeds if we get pluginDirs
    expect(result.pluginDirs).toBeDefined()
    expect(result.pluginDirs.length).toBeGreaterThan(0)

    // Check that plugin directories exist
    for (const pluginDir of result.pluginDirs) {
      const exists = await fs
        .access(pluginDir)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    }
  })

  test('generates valid plugin.json for each space', async () => {
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    expect(result.pluginDirs.length).toBeGreaterThan(0)

    for (const pluginDir of result.pluginDirs) {
      const pluginJsonPath = path.join(pluginDir, '.claude-plugin', 'plugin.json')
      const exists = await fs
        .access(pluginJsonPath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)

      // Verify plugin.json structure
      const content = await fs.readFile(pluginJsonPath, 'utf-8')
      const pluginJson = JSON.parse(content)

      // Required field: name (kebab-case)
      expect(pluginJson.name).toBeDefined()
      expect(pluginJson.name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  test('includes component directories', async () => {
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Find a plugin dir that has a commands directory
    let foundFrontendCommands = false
    for (const pluginDir of result.pluginDirs) {
      const commandsDir = path.join(pluginDir, 'commands')
      const exists = await fs
        .access(commandsDir)
        .then(() => true)
        .catch(() => false)

      if (exists) {
        // Check for specific command files
        const buildMd = path.join(commandsDir, 'build.md')
        const buildExists = await fs
          .access(buildMd)
          .then(() => true)
          .catch(() => false)
        if (buildExists) {
          foundFrontendCommands = true
          break
        }
      }
    }

    expect(foundFrontendCommands).toBe(true)
  })

  test('returns warnings for command collisions', async () => {
    // Frontend and backend both have /build command
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Should have warnings
    expect(result.warnings.length).toBeGreaterThan(0)

    // Should have a command collision warning (W201)
    const hasCollision = result.warnings.some((w) => w.code === 'W201')
    expect(hasCollision).toBe(true)
  })

  test('no collision warning for single space target', async () => {
    // Create project with just one space
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

    const result = await build('single', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Should have no command collision warnings
    const collisionWarnings = result.warnings.filter((w) => w.code === 'W201')
    expect(collisionWarnings.length).toBe(0)
  })

  test('emits W101 warning when lock file is missing and auto-generated', async () => {
    // Create project without installing (no lock file)
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      single: {
        compose: ['space:base@stable'],
      },
    })

    // Build with autoInstall=true (default)
    // This should auto-generate the lock file and emit W101
    const result = await build('single', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
      autoInstall: true,
    })

    // Should have W101 lock-missing warning
    const lockMissingWarning = result.warnings.find((w) => w.code === 'W101')
    expect(lockMissingWarning).toBeDefined()
    expect(lockMissingWarning?.severity).toBe('info')
    expect(lockMissingWarning?.message).toContain('auto-generated')
  })
})
