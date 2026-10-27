/**
 * Integration tests for management commands: add, remove, upgrade.
 *
 * WHY: These commands modify asp-targets.toml and lock files, which are
 * critical operations that need end-to-end validation.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { LOCK_FILENAME, readLockJson } from 'spaces-config'
import { install } from 'spaces-execution'

import {
  SAMPLE_REGISTRY_DIR,
  cleanupTempAspHome,
  cleanupTempProject,
  createTempAspHome,
  createTempProject,
  initSampleRegistry,
} from './setup.js'

async function advancedRegistry(projectDir: string): Promise<string> {
  const registry = path.join(projectDir, 'registry-copy')
  await fs.cp(SAMPLE_REGISTRY_DIR, registry, { recursive: true })
  await fs.writeFile(path.join(registry, 'spaces/frontend/upgrade-marker.txt'), 'new frontend\n')
  await fs.writeFile(path.join(registry, 'spaces/backend/upgrade-marker.txt'), 'new backend\n')
  const git = (...args: string[]) => execFileSync('git', args, { cwd: registry, encoding: 'utf8' })
  git('add', 'spaces/frontend/upgrade-marker.txt', 'spaces/backend/upgrade-marker.txt')
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'advance stable spaces'
  )
  git('tag', '-f', 'space/frontend/v1.0.0')
  git('tag', '-f', 'space/backend/v1.0.0')
  return registry
}

function commitFor(lock: Awaited<ReturnType<typeof readLockJson>>, id: string) {
  return Object.values(lock.spaces).find((entry) => entry.id === id)?.commit
}

// Initialize registry once for all tests in this file
beforeAll(async () => {
  await initSampleRegistry()
})

describe('install lock reuse', () => {
  let aspHome: string
  let projectDir: string
  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({ dev: { compose: ['space:frontend@stable'] } })
    await install({ projectPath: projectDir, registryPath: SAMPLE_REGISTRY_DIR, aspHome })
  })
  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('full update follows moved selectors for every target', async () => {
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.api]\ncompose = ["space:backend@stable"]\n'
    )
    await install({ projectPath: projectDir, registryPath: SAMPLE_REGISTRY_DIR, aspHome })
    const before = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = await advancedRegistry(projectDir)
    await install({ projectPath: projectDir, registryPath: registry, aspHome, update: true })
    const after = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(commitFor(after, 'frontend')).not.toBe(commitFor(before, 'frontend'))
    expect(commitFor(after, 'backend')).not.toBe(commitFor(before, 'backend'))
  })

  test('default install preserves a locked selector while resolving a new target', async () => {
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = await advancedRegistry(projectDir)
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.api]\ncompose = ["space:backend@stable"]\n'
    )
    await install({ projectPath: projectDir, registryPath: registry, aspHome })
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(commitFor(lock, 'frontend')).toBe(commitFor(oldLock, 'frontend'))
    expect(commitFor(lock, 'backend')).toBeDefined()
    expect(commitFor(lock, 'backend')).not.toBe(commitFor(oldLock, 'frontend'))
  })

  test('a changed selector resolves freshly instead of reusing the prior selection', async () => {
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = await advancedRegistry(projectDir)
    execFileSync('git', ['tag', '-f', 'space/frontend/v1.1.0', 'HEAD'], { cwd: registry })
    const targetsPath = path.join(projectDir, 'asp-targets.toml')
    const targets = await fs.readFile(targetsPath, 'utf8')
    await fs.writeFile(
      targetsPath,
      targets.replace('space:frontend@stable', 'space:frontend@latest')
    )
    await install({ projectPath: projectDir, registryPath: registry, aspHome })
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const frontend = Object.values(lock.spaces).find((entry) => entry.id === 'frontend')
    expect(frontend?.resolvedFrom?.selector).toBe('latest')
    expect(frontend?.resolvedFrom?.tag).not.toBe(
      Object.values(oldLock.spaces).find((entry) => entry.id === 'frontend')?.resolvedFrom?.tag
    )
  })

  test('distinct selectors for one space remain distinct across targets', async () => {
    const registry = await advancedRegistry(projectDir)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: registry, encoding: 'utf8' }).trim()
    git('tag', '-f', 'space/frontend/v1.0.0', 'HEAD^')
    git('tag', '-f', 'space/frontend/v1.1.0', 'HEAD')
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.other]\ncompose = ["space:frontend@latest"]\n'
    )
    await install({ projectPath: projectDir, registryPath: registry, aspHome, update: true })
    const before = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const entries = Object.values(before.spaces).filter((entry) => entry.id === 'frontend')
    expect(entries.map((entry) => entry.resolvedFrom?.selector).sort()).toEqual([
      'latest',
      'stable',
    ])
    await fs.writeFile(path.join(registry, 'spaces/frontend/second-marker.txt'), 'next\n')
    git('add', 'spaces/frontend/second-marker.txt')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'advance again'
    )
    git('tag', '-f', 'space/frontend/v1.0.0')
    await install({ projectPath: projectDir, registryPath: registry, aspHome })
    const after = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    for (const original of entries) {
      const matching = Object.values(after.spaces).find(
        (entry) =>
          entry.id === 'frontend' &&
          entry.resolvedFrom?.selector === original.resolvedFrom?.selector
      )
      expect(matching?.commit).toBe(original.commit)
    }
  })

  test('a newly introduced transitive dependency resolves while existing roots stay locked', async () => {
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = await advancedRegistry(projectDir)
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: registry, encoding: 'utf8' })
    git('tag', '-f', 'space/frontend/v1.1.0', 'HEAD')
    const manifestPath = path.join(registry, 'spaces/backend/space.toml')
    const manifest = await fs.readFile(manifestPath, 'utf8')
    await fs.writeFile(
      manifestPath,
      manifest.replace('space:base@stable', 'space:base@stable", "space:frontend@latest')
    )
    git('add', 'spaces/backend/space.toml')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'add dependency'
    )
    git('tag', '-f', 'space/backend/v1.0.0')
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.api]\ncompose = ["space:backend@stable"]\n'
    )
    await install({ projectPath: projectDir, registryPath: registry, aspHome })
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const frontend = Object.values(lock.spaces).filter((entry) => entry.id === 'frontend')
    expect(frontend.find((entry) => entry.resolvedFrom?.selector === 'stable')?.commit).toBe(
      commitFor(oldLock, 'frontend')
    )
    expect(frontend.find((entry) => entry.resolvedFrom?.selector === 'latest')).toBeDefined()
  })

  test('a new target reuses the locked dependency graph of a shared immutable space', async () => {
    const before = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = path.join(projectDir, 'shared-registry')
    await fs.cp(SAMPLE_REGISTRY_DIR, registry, { recursive: true })
    await fs.writeFile(path.join(registry, 'spaces/base/new-marker.txt'), 'next base\n')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: registry, encoding: 'utf8' })
    git('add', 'spaces/base/new-marker.txt')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'move base'
    )
    git('tag', '-f', 'space/base/v1.0.0')
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.other]\ncompose = ["space:frontend@stable"]\n'
    )
    await install({ projectPath: projectDir, registryPath: registry, aspHome })
    const after = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(commitFor(after, 'base')).toBe(commitFor(before, 'base'))
    expect(after.targets['dev']?.loadOrder).toEqual(after.targets['other']?.loadOrder)
  })

  test('partial update refuses atomically when a shared locked dependency graph would change', async () => {
    await fs.appendFile(
      path.join(projectDir, 'asp-targets.toml'),
      '\n[targets.other]\ncompose = ["space:frontend@stable"]\n'
    )
    await install({ projectPath: projectDir, registryPath: SAMPLE_REGISTRY_DIR, aspHome })
    const lockPath = path.join(projectDir, LOCK_FILENAME)
    const before = await fs.readFile(lockPath, 'utf8')
    const registry = path.join(projectDir, 'shared-registry')
    await fs.cp(SAMPLE_REGISTRY_DIR, registry, { recursive: true })
    await fs.writeFile(path.join(registry, 'spaces/base/new-marker.txt'), 'next base\n')
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: registry, encoding: 'utf8' })
    git('add', 'spaces/base/new-marker.txt')
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-m',
      'move base'
    )
    git('tag', '-f', 'space/base/v1.0.0')
    await expect(
      install({
        projectPath: projectDir,
        registryPath: registry,
        aspHome,
        targets: ['other'],
        update: true,
      })
    ).rejects.toThrow()
    expect(await fs.readFile(lockPath, 'utf8')).toBe(before)
  })
  test('can upgrade specific space by ID', async () => {
    await cleanupTempProject(projectDir)
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable', 'space:backend@stable'],
      },
    })

    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))

    const registry = await advancedRegistry(projectDir)

    // Upgrade only frontend
    await install({
      projectPath: projectDir,
      registryPath: registry,
      aspHome,
      update: true,
      upgradeSpaceIds: ['frontend'],
    })

    const newLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))

    expect(commitFor(newLock, 'frontend')).not.toBe(commitFor(oldLock, 'frontend'))

    // Backend should remain unchanged (same commit)
    const oldBackend = Object.entries(oldLock.spaces).find(([key]) => key.startsWith('backend@'))
    const newBackend = Object.entries(newLock.spaces).find(([key]) => key.startsWith('backend@'))

    expect(oldBackend).toBeDefined()
    expect(newBackend).toBeDefined()
    expect(oldBackend?.[1].commit).toBe(newBackend?.[1].commit)
  })
})
