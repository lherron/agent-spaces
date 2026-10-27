/**
 * Integration tests for utility commands: diff, explain, list, doctor, gc.
 *
 * WHY: These commands provide information and maintenance functionality
 * that users rely on for understanding and managing their spaces.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import {
  LOCK_FILENAME,
  PathResolver,
  explain,
  readLockJson,
  readTargetsToml,
  runGC,
} from 'spaces-config'
import { install } from 'spaces-execution'

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
    manifest.targets['dev']!.compose = manifest.targets['dev']!.compose!.filter(
      (r) => !r.includes('backend')
    )

    let toml = `schema = ${manifest.schema}\n\n`
    for (const [name, t] of Object.entries(manifest.targets)) {
      toml += `[targets.${name}]\n`
      toml += 'compose = [\n'
      for (const ref of t.compose ?? []) {
        toml += `  "${ref}",\n`
      }
      toml += ']\n\n'
    }
    await fs.writeFile(path.join(projectDir, 'asp-targets.toml'), toml)

    // Resolve fresh
    const { resolveTarget } = await import('spaces-config')
    const freshResult = await resolveTarget('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      useLock: false,
    })

    // Fresh should not have backend
    const freshHasBackend = freshResult.lock.targets['dev']!.loadOrder.some((key) =>
      key.startsWith('backend@')
    )
    expect(freshHasBackend).toBe(false)

    // Original lock should have backend
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const oldHasBackend = oldLock.targets['dev']!.loadOrder.some((key) =>
      key.startsWith('backend@')
    )
    expect(oldHasBackend).toBe(true)
  })

  test('reports no changes when lock matches manifest', async () => {
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Resolve fresh
    const { resolveTarget } = await import('spaces-config')
    const freshResult = await resolveTarget('dev', {
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      useLock: false,
    })

    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))

    // Load orders should match
    expect(freshResult.lock.targets['dev']!.loadOrder).toEqual(oldLock.targets['dev']!.loadOrder)
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
    expect(result.targets['dev']!.compose).toContain('space:frontend@stable')
    expect(result.targets['dev']!.compose).toContain('space:backend@stable')
    const frontendSpace = result.targets['dev']!.spaces.find((space) => space.id === 'frontend')
    expect(frontendSpace?.pluginName).toBe('frontend')
    expect(frontendSpace?.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(frontendSpace?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(frontendSpace?.inStore).toBe(true)
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
    // The collision lives in a dedicated pair rather than in frontend/backend, so
    // this case builds its own project instead of using the shared `dev` above.
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      dev: {
        compose: ['space:cmd-collision-a@stable', 'space:cmd-collision-b@stable'],
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
    })

    // cmd-collision-a and cmd-collision-b both ship a 'build' command
    const hasCollisionWarning = result.targets['dev']!.warnings.some(
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
    await install({ projectPath: projectDir, registryPath: SAMPLE_REGISTRY_DIR, aspHome })
    const cli = path.join(import.meta.dir, '..', '..', 'apps', 'cli', 'bin', 'asp.js')
    const output = JSON.parse(
      execFileSync('bun', [cli, 'list', '--json', '--project', projectDir, '--asp-home', aspHome], {
        encoding: 'utf8',
      })
    )
    expect(output.hasLock).toBe(true)
    expect(output.targets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'dev',
          description: 'Development environment',
          compose: ['space:frontend@stable'],
          locked: true,
        }),
        expect.objectContaining({
          name: 'prod',
          description: 'Production environment',
          compose: ['space:backend@stable'],
          locked: true,
        }),
      ])
    )
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

  test('dry run does not delete files', async () => {
    const paths = new PathResolver({ aspHome })

    // Create an orphan snapshot
    const orphanIntegrity: `sha256:${string}` = `sha256:${'1'.repeat(64)}`
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
    const orphanIntegrity: `sha256:${string}` = `sha256:${'2'.repeat(64)}`
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

    // The orphan is really gone, not merely counted.
    const orphanStillExists = await fs
      .access(orphanPath)
      .then(() => true)
      .catch(() => false)
    expect(orphanStillExists).toBe(false)

    // bytesFreed is a whole-run total: `runGC` accumulates it over snapshots,
    // unreachable cache entries AND pruned bundle versions (gc.ts), so it is a
    // lower bound on this orphan's 1000 bytes, never an equality. The old
    // `toBe(1000)` asserted a sum the product has not produced since bundle
    // pruning joined the tally.
    expect(result.bytesFreed).toBeGreaterThanOrEqual(1000)
  })
})
