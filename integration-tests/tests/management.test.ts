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

describe('asp upgrade', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        compose: ['space:frontend@stable'],
      },
    })

    // Install to create lock file
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

  test('update follows moved stable tags while a normal install keeps the locked commit', async () => {
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const registry = await advancedRegistry(projectDir)
    await install({ projectPath: projectDir, registryPath: registry, aspHome, update: false })
    const unchanged = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(commitFor(unchanged, 'frontend')).toBe(commitFor(oldLock, 'frontend'))
    await install({ projectPath: projectDir, registryPath: registry, aspHome, update: true })
    const upgraded = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(commitFor(upgraded, 'frontend')).not.toBe(commitFor(oldLock, 'frontend'))
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
