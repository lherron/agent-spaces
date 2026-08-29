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

import type { BuildResult, LintContext, SpaceLintData } from 'spaces-config'
import { getLoadOrderEntries, lint as lintApi } from 'spaces-config'
import { build, install } from 'spaces-execution'

const { lint } = lintApi

/**
 * Rebuild the lint context `build()` itself constructs, over the plugin dirs a
 * completed build produced.
 *
 * WHY this and not a second `build({ clean: false })`: plugin dirs are
 * content-addressed cache entries, and the second build re-materializes them
 * from source before lint runs, so anything injected into one is gone by the
 * time a rule could see it (`clean: false` protects the output dir, not the
 * cache). Both rules below fire only on hand-edited plugin directories -- W206
 * because materialization runs `ensureHooksExecutable` first, W207 because
 * materialization never nests component dirs under `.claude-plugin/` -- so the
 * honest integration is to build real artifacts, edit one, and run the real
 * lint entrypoint over it. Pairing is by load-order index, exactly as
 * `build()` pairs `getLoadOrderEntries` with `pluginDirs`.
 */
function lintContextFor(built: BuildResult, targetName = 'test'): LintContext {
  const entries = getLoadOrderEntries(built.lock, targetName)
  const spaces: SpaceLintData[] = entries.map((entry, i) => ({
    key: `${entry.id}@${entry.commit.slice(0, 12)}` as SpaceLintData['key'],
    manifest: { schema: 1 as const, id: entry.id, plugin: entry.plugin },
    pluginPath: built.pluginDirs[i] ?? '',
  }))
  return { spaces }
}

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
    // The colliding pair is dedicated fixture content. frontend/backend used to
    // carry the duplicate /build themselves, which made them un-materializable
    // together on the `spaces:` path (detectCommandConflicts throws there, unlike
    // lint, which only warns). Only the two W201 cases below use this project;
    // every other test in this file builds its own.
    projectDir = await createTempProject({
      dev: {
        compose: ['space:cmd-collision-a@stable', 'space:cmd-collision-b@stable'],
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
    // cmd-collision-a and cmd-collision-b both ship /build
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
    // cmd-collision-a and cmd-collision-b both ship /build
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

    const built = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })
    expect(built.pluginDirs.length).toBe(2) // frontend + base

    const pluginDir = built.pluginDirs[0]
    expect(pluginDir).toBeDefined()
    if (pluginDir === undefined) return

    // Manually create a hooks directory with a non-executable script.
    const hooksDir = path.join(pluginDir, 'hooks')
    await fs.mkdir(hooksDir, { recursive: true })
    await fs.writeFile(
      path.join(hooksDir, 'hooks.json'),
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              hooks: [
                { type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/not-executable.sh' },
              ],
            },
          ],
        },
      })
    )
    await fs.writeFile(path.join(hooksDir, 'not-executable.sh'), '#!/bin/sh\necho hi\n')
    await fs.chmod(path.join(hooksDir, 'not-executable.sh'), 0o644)

    const warnings = await lint(lintContextFor(built))
    const warning = warnings.find((w) => w.code === 'W206')
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('not executable')
  })

  test('detects invalid plugin structure (W207)', async () => {
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

    const built = await build('test', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      outputDir,
    })
    expect(built.pluginDirs.length).toBe(2) // frontend + base

    const pluginDir = built.pluginDirs[0]
    expect(pluginDir).toBeDefined()
    if (pluginDir === undefined) return

    // Component directory nested inside .claude-plugin/ -- the misconfiguration
    // W207 exists to catch. Materialization never produces this shape, so it can
    // only come from a hand-edited plugin dir, which is what this injects.
    const badDir = path.join(pluginDir, '.claude-plugin', 'commands')
    await fs.mkdir(badDir, { recursive: true })
    await fs.writeFile(path.join(badDir, 'wrong.md'), '# /wrong\nThis is in the wrong place.')

    const warnings = await lint(lintContextFor(built))
    const warning = warnings.find((w) => w.code === 'W207')
    expect(warning).toBeDefined()
    expect(warning?.message).toContain('commands/')
    expect(warning?.message).toContain('.claude-plugin')
  })
})
