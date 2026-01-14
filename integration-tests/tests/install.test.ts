/**
 * Integration tests for `asp install` command.
 *
 * WHY: The install command is fundamental to Agent Spaces. It resolves
 * targets from asp-targets.toml, generates asp-lock.json, and populates
 * the store with space snapshots. This needs end-to-end validation.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'

import { install } from 'spaces-engine'
import { PathResolver } from 'spaces-store'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

describe('asp install', () => {
  let aspHome: string
  let projectDir: string

  beforeAll(async () => {
    // Initialize the sample registry once
    await initSampleRegistry()
  })

  afterAll(async () => {
    // Note: Don't clean up sample registry - other parallel tests may need it
  })

  beforeEach(async () => {
    // Create fresh temp directories for each test
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('generates lock file for project with compose targets', async () => {
    // Run install
    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Verify result - install succeeds if we get a lock and lockPath
    expect(result.lock).toBeDefined()
    expect(result.lockPath).toBeDefined()
    expect(result.resolvedTargets).toContain('dev')

    // Verify lock file was created
    const lockExists = await fs
      .access(result.lockPath)
      .then(() => true)
      .catch(() => false)
    expect(lockExists).toBe(true)

    // Verify lock file structure
    expect(result.lock.lockfileVersion).toBe(1)
    expect(result.lock.targets).toHaveProperty('dev')
    expect(result.lock.targets.dev.loadOrder).toBeDefined()
    expect(result.lock.targets.dev.loadOrder.length).toBeGreaterThan(0)
  })

  test('resolves transitive dependencies', async () => {
    // Frontend depends on base, so base should be in load order
    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.lock).toBeDefined()

    // Check that base is in load order (transitive dep)
    const loadOrder = result.lock.targets.dev.loadOrder
    const hasBase = loadOrder.some((key) => key.startsWith('base@'))
    expect(hasBase).toBe(true)

    // Base should come before frontend (DFS postorder)
    const baseIndex = loadOrder.findIndex((key) => key.startsWith('base@'))
    const frontendIndex = loadOrder.findIndex((key) => key.startsWith('frontend@'))
    expect(baseIndex).toBeLessThan(frontendIndex)
  })

  test('populates store with space snapshots', async () => {
    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.snapshotsCreated).toBeGreaterThan(0)

    // Check store has entries
    const pathResolver = new PathResolver({ aspHome })
    const storeDir = pathResolver.store

    const entries = await fs.readdir(storeDir, { withFileTypes: true })
    const hasSnapshots = entries.some((e) => e.isDirectory())
    expect(hasSnapshots).toBe(true)
  })

  test('computes environment hash', async () => {
    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Check envHash is present and properly formatted
    const envHash = result.lock.targets.dev.envHash
    expect(envHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test('records integrity hashes for spaces', async () => {
    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Check that spaces have integrity hashes
    const spaces = Object.values(result.lock.spaces)
    expect(spaces.length).toBeGreaterThan(0)
    for (const space of spaces) {
      expect(space.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    }
  })

  test('handles single target', async () => {
    // Create project with single frontend target
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      frontend: {
        compose: ['space:frontend@stable'],
      },
    })

    const result = await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.resolvedTargets).toContain('frontend')
    expect(result.resolvedTargets).not.toContain('dev')
    expect(result.lock.targets).toHaveProperty('frontend')
    expect(result.lock.targets).not.toHaveProperty('dev')
  })
})
