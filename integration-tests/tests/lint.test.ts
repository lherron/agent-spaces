/**
 * Integration tests for `asp lint` functionality.
 *
 * WHY: Linting detects issues like command collisions, invalid hooks,
 * and plugin name conflicts. These warnings help users avoid runtime
 * issues before they run Claude.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'

import { build, install } from '@agent-spaces/engine'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupSampleRegistry,
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
})
