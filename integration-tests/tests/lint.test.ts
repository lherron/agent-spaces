/**
 * Integration tests for `asp lint` functionality.
 *
 * WHY: Linting detects issues like command collisions, invalid hooks,
 * and plugin name conflicts. These warnings help users avoid runtime
 * issues before they run Claude.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { build, install } from 'spaces-engine'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

describe('asp lint integration', () => {
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
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })
    outputDir = await fs.mkdtemp('/tmp/asp-lint-output-')

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

  test('detects command collisions (W201)', async () => {
    // Frontend and backend both have /build command
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Build succeeds if we get warnings array
    expect(result.warnings).toBeDefined()

    // Check for W201 warning
    const collisionWarning = result.warnings.find((w) => w.code === 'W201')
    expect(collisionWarning).toBeDefined()

    if (collisionWarning) {
      expect(collisionWarning.message).toContain('build')
    }
  })

  test('no collision warning for unique commands', async () => {
    // Create project with just frontend (has unique test command)
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      single: {
        compose: ['space:frontend@stable'],
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

  test('includes all spaces in collision warning details', async () => {
    // Frontend and backend both have /build command
    const result = await build('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    const collisionWarning = result.warnings.find((w) => w.code === 'W201')
    expect(collisionWarning).toBeDefined()

    if (collisionWarning?.details) {
      const details = collisionWarning.details as { command: string; spaces: string[] }
      expect(details.command).toBe('build')
      expect(details.spaces.length).toBe(2)
    }
  })

  test('detects hook paths with relative references (W203)', async () => {
    // Use space with hooks that use relative paths like ../scripts/setup.sh
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      test: {
        compose: ['space:hooks-bad-path@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Check for W203 warning
    const warning = result.warnings.find((w) => w.code === 'W203')
    expect(warning).toBeDefined()

    if (warning) {
      expect(warning.message).toContain('relative path')
      expect(warning.message).toContain('../scripts/setup.sh')
    }
  })

  test('detects invalid hooks config (W204)', async () => {
    // Use space with hooks directory but invalid hooks.json
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      test: {
        compose: ['space:hooks-invalid@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Check for W204 warning
    const warning = result.warnings.find((w) => w.code === 'W204')
    expect(warning).toBeDefined()

    if (warning) {
      expect(warning.message).toContain('hooks.json')
      expect(warning.message).toContain('invalid')
    }
  })

  test('detects plugin name collisions (W205)', async () => {
    // Use two spaces that both use plugin name "shared-plugin"
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      test: {
        compose: ['space:same-plugin-a@stable', 'space:same-plugin-b@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Check for W205 warning
    const warning = result.warnings.find((w) => w.code === 'W205')
    expect(warning).toBeDefined()

    if (warning) {
      expect(warning.message).toContain('shared-plugin')
      expect(warning.message).toContain('multiple spaces')
    }
  })

  test('detects non-executable hook scripts (W206)', async () => {
    // Note: The materializer calls ensureHooksExecutable which fixes permissions
    // BEFORE lint runs. However, the lint rule W206 is still useful for detecting
    // issues in manually-created plugin directories.
    //
    // This test verifies the lint rule works by creating a bad structure
    // AFTER materialization, simulating a manual misconfiguration.

    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      test: {
        compose: ['space:frontend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // First build to create the structure
    const result1 = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Get a plugin directory (plugin dirs use content hashes, not names)
    const pluginDirs = result1.pluginDirs
    expect(pluginDirs.length).toBe(2) // frontend + base

    // Use the first plugin dir
    const pluginDir = pluginDirs[0]
    expect(pluginDir).toBeDefined()

    // Manually create a hooks directory with non-executable script
    const hooksDir = path.join(pluginDir, 'hooks')
    await fs.mkdir(hooksDir, { recursive: true })

    // Create hooks.json
    await fs.writeFile(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: [{ event: 'SessionStart', script: 'bad-script.sh' }],
      })
    )

    // Create non-executable script (mode 644)
    await fs.writeFile(path.join(hooksDir, 'bad-script.sh'), '#!/bin/bash\necho "test"', {
      mode: 0o644,
    })

    // Run lint through a fresh build
    const result2 = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
      clean: false, // Don't clean so we keep our manual changes
    })

    // Check for W206 warning
    const warning = result2.warnings.find((w) => w.code === 'W206')
    expect(warning).toBeDefined()

    if (warning) {
      expect(warning.message).toContain('not executable')
    }
  })

  test('detects invalid plugin structure (W207)', async () => {
    // Note: The normal materialization flow doesn't copy .claude-plugin/* from source.
    // It generates .claude-plugin/plugin.json fresh. So this test creates a bad
    // structure AFTER materialization to verify the lint rule works.

    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      test: {
        compose: ['space:frontend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // First build to create the structure
    const result1 = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })

    // Get a plugin directory (plugin dirs use content hashes, not names)
    const pluginDirs = result1.pluginDirs
    expect(pluginDirs.length).toBe(2) // frontend + base

    // Use the first plugin dir
    const pluginDir = pluginDirs[0]
    expect(pluginDir).toBeDefined()

    // Manually create component directory inside .claude-plugin (bad structure)
    const badDir = path.join(pluginDir, '.claude-plugin', 'commands')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'wrong.md'), '# /wrong\nThis is in the wrong place.')

    // Run lint through a fresh build
    const result2 = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
      clean: false, // Don't clean so we keep our manual changes
    })

    // Check for W207 warning
    const warning = result2.warnings.find((w) => w.code === 'W207')
    expect(warning).toBeDefined()

    if (warning) {
      expect(warning.message).toContain('commands/')
      expect(warning.message).toContain('.claude-plugin')
    }
  })
})
