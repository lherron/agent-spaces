/**
 * Integration tests for utility commands: diff, explain, list, doctor, gc.
 *
 * WHY: These commands provide information and maintenance functionality
 * that users rely on for understanding and managing their spaces.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { LOCK_FILENAME, readLockJson, readTargetsToml } from '@agent-spaces/core'
import { explain, install } from '@agent-spaces/engine'
import { PathResolver, runGC } from '@agent-spaces/store'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

// Initialize registry once for all tests in this file
beforeAll(async () => {
  await initSampleRegistry()
})

describe('asp diff', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable'],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('detects added spaces', async () => {
    // Install initial state
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Modify manifest to add backend
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    manifest.targets.dev.compose.push('space:backend@stable' as never)

    let toml = `schema = ${manifest.schema}\n\n`
    for (const [name, t] of Object.entries(manifest.targets)) {
      toml += `[targets.${name}]\n`
      toml += 'compose = [\n'
      for (const ref of t.compose) {
        toml += `  "${ref}",\n`
      }
      toml += ']\n\n'
    }
    await fs.writeFile(path.join(projectDir, 'asp-targets.toml'), toml)

    // Resolve fresh (without lock) to get new state
    const { resolveTarget } = await import('@agent-spaces/engine')
    const freshResult = await resolveTarget('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      useLock: false,
    })

    // Check that backend is in the fresh resolution
    const hasBackend = freshResult.lock.targets.dev.loadOrder.some((key) =>
      key.startsWith('backend@')
    )
    expect(hasBackend).toBe(true)

    // Original lock should not have backend
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const oldHasBackend = oldLock.targets.dev.loadOrder.some((key) => key.startsWith('backend@'))
    expect(oldHasBackend).toBe(false)
  })

  test('detects removed spaces', async () => {
    // Create project with two spaces
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })

    // Install
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Remove backend from manifest
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    manifest.targets.dev.compose = manifest.targets.dev.compose.filter(
      (r) => !r.includes('backend')
    )

    let toml = `schema = ${manifest.schema}\n\n`
    for (const [name, t] of Object.entries(manifest.targets)) {
      toml += `[targets.${name}]\n`
      toml += 'compose = [\n'
      for (const ref of t.compose) {
        toml += `  "${ref}",\n`
      }
      toml += ']\n\n'
    }
    await fs.writeFile(path.join(projectDir, 'asp-targets.toml'), toml)

    // Resolve fresh
    const { resolveTarget } = await import('@agent-spaces/engine')
    const freshResult = await resolveTarget('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      useLock: false,
    })

    // Fresh should not have backend
    const freshHasBackend = freshResult.lock.targets.dev.loadOrder.some((key) =>
      key.startsWith('backend@')
    )
    expect(freshHasBackend).toBe(false)

    // Original lock should have backend
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const oldHasBackend = oldLock.targets.dev.loadOrder.some((key) => key.startsWith('backend@'))
    expect(oldHasBackend).toBe(true)
  })

  test('reports no changes when lock matches manifest', async () => {
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Resolve fresh
    const { resolveTarget } = await import('@agent-spaces/engine')
    const freshResult = await resolveTarget('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      useLock: false,
    })

    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))

    // Load orders should match
    expect(freshResult.lock.targets.dev.loadOrder).toEqual(oldLock.targets.dev.loadOrder)
  })
})

describe('asp explain', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('returns target information', async () => {
    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.targets).toHaveProperty('dev')
    expect(result.targets.dev.compose).toContain('space:frontend@stable')
    expect(result.targets.dev.compose).toContain('space:backend@stable')
  })

  test('includes load order with dependencies first', async () => {
    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const loadOrder = result.targets.dev.loadOrder

    // base should come before frontend and backend
    const baseIndex = loadOrder.findIndex((key) => key.startsWith('base@'))
    const frontendIndex = loadOrder.findIndex((key) => key.startsWith('frontend@'))
    const backendIndex = loadOrder.findIndex((key) => key.startsWith('backend@'))

    expect(baseIndex).toBeLessThan(frontendIndex)
    expect(baseIndex).toBeLessThan(backendIndex)
  })

  test('includes space details', async () => {
    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const frontendSpace = result.targets.dev.spaces.find((s) => s.id === 'frontend')
    expect(frontendSpace).toBeDefined()
    expect(frontendSpace?.pluginName).toBe('frontend')
    expect(frontendSpace?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(frontendSpace?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(frontendSpace?.inStore).toBe(true)
  })

  test('includes env hash', async () => {
    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(result.targets.dev.envHash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test('can explain specific target', async () => {
    // Create project with multiple targets
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable'],
      },
      prod: {
        compose: ['space:backend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      targets: ['dev'],
    })

    expect(Object.keys(result.targets)).toEqual(['dev'])
    expect(result.targets).not.toHaveProperty('prod')
  })

  test('detects warnings (command collisions)', async () => {
    const result = await explain({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Both frontend and backend have 'build' command
    const hasCollisionWarning = result.targets.dev.warnings.some(
      (w) => w.code === 'W201' && w.message.includes('build')
    )
    expect(hasCollisionWarning).toBe(true)
  })
})

describe('asp list', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable'],
      },
      prod: {
        description: 'Production environment',
        compose: ['space:backend@stable'],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('lists targets from manifest', async () => {
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))

    expect(Object.keys(manifest.targets)).toContain('dev')
    expect(Object.keys(manifest.targets)).toContain('prod')
    expect(manifest.targets.dev.description).toBe('Development environment')
    expect(manifest.targets.prod.description).toBe('Production environment')
  })

  test('shows locked status when lock exists', async () => {
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(lock.targets).toHaveProperty('dev')
    expect(lock.targets).toHaveProperty('prod')
    expect(lock.targets.dev.envHash).toMatch(/^sha256:/)
  })

  test('shows compose lists', async () => {
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))

    expect(manifest.targets.dev.compose).toContain('space:frontend@stable')
    expect(manifest.targets.prod.compose).toContain('space:backend@stable')
  })
})

describe('asp doctor', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable'],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('checks ASP_HOME exists', async () => {
    const paths = new PathResolver({ aspHome })

    // Verify snapshots path exists
    const snapshotsExists = await fs
      .access(paths.snapshots)
      .then(() => true)
      .catch(() => false)
    expect(snapshotsExists).toBe(true)

    // Verify cache path exists
    const cacheExists = await fs
      .access(paths.cache)
      .then(() => true)
      .catch(() => false)
    expect(cacheExists).toBe(true)
  })

  test('checks project exists', async () => {
    const targetsPath = path.join(projectDir, 'asp-targets.toml')
    const exists = await fs
      .access(targetsPath)
      .then(() => true)
      .catch(() => false)
    expect(exists).toBe(true)
  })
})

describe('asp gc', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable'],
      },
    })

    // Install to populate store
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('keeps referenced snapshots', async () => {
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const paths = new PathResolver({ aspHome })

    // Run GC
    const result = await runGC([lock], {
      paths,
      cwd: SAMPLE_REGISTRY_DIR,
      dryRun: false,
    })

    // Should not delete anything since all are referenced
    expect(result.snapshotsDeleted).toBe(0)

    // Verify snapshots still exist
    for (const spaceEntry of Object.values(lock.spaces)) {
      const snapshotPath = paths.snapshot(spaceEntry.integrity)
      const exists = await fs
        .access(snapshotPath)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(true)
    }
  })

  test('removes unreferenced snapshots', async () => {
    const paths = new PathResolver({ aspHome })

    // Create an orphan snapshot
    const orphanIntegrity = `sha256:${'0'.repeat(64)}`
    const orphanPath = paths.snapshot(orphanIntegrity)
    await fs.mkdir(orphanPath, { recursive: true })
    await fs.writeFile(path.join(orphanPath, 'test.txt'), 'orphan content')

    // Verify orphan exists
    const orphanExists = await fs
      .access(orphanPath)
      .then(() => true)
      .catch(() => false)
    expect(orphanExists).toBe(true)

    // Run GC with current lock (which does not reference orphan)
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const result = await runGC([lock], {
      paths,
      cwd: SAMPLE_REGISTRY_DIR,
      dryRun: false,
    })

    // Should have deleted the orphan
    expect(result.snapshotsDeleted).toBe(1)

    // Verify orphan is gone
    const orphanStillExists = await fs
      .access(orphanPath)
      .then(() => true)
      .catch(() => false)
    expect(orphanStillExists).toBe(false)
  })

  test('dry run does not delete files', async () => {
    const paths = new PathResolver({ aspHome })

    // Create an orphan snapshot
    const orphanIntegrity = `sha256:${'1'.repeat(64)}`
    const orphanPath = paths.snapshot(orphanIntegrity)
    await fs.mkdir(orphanPath, { recursive: true })
    await fs.writeFile(path.join(orphanPath, 'test.txt'), 'orphan content')

    // Run GC in dry-run mode
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const result = await runGC([lock], {
      paths,
      cwd: SAMPLE_REGISTRY_DIR,
      dryRun: true,
    })

    // Should report what would be deleted
    expect(result.snapshotsDeleted).toBe(1)

    // But orphan should still exist
    const orphanStillExists = await fs
      .access(orphanPath)
      .then(() => true)
      .catch(() => false)
    expect(orphanStillExists).toBe(true)
  })

  test('deletes orphan and reports count', async () => {
    const paths = new PathResolver({ aspHome })

    // Create an orphan snapshot with known content
    const orphanIntegrity = `sha256:${'2'.repeat(64)}`
    const orphanPath = paths.snapshot(orphanIntegrity)
    await fs.mkdir(orphanPath, { recursive: true })
    await fs.writeFile(path.join(orphanPath, 'test.txt'), 'x'.repeat(1000))

    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const result = await runGC([lock], {
      paths,
      cwd: SAMPLE_REGISTRY_DIR,
      dryRun: false,
    })

    // Should report snapshot deleted
    expect(result.snapshotsDeleted).toBe(1)

    // bytesFreed should include the size of deleted content
    // The orphan file is 1000 bytes ('x'.repeat(1000))
    expect(result.bytesFreed).toBe(1000)
  })
})
