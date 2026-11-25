/**
 * Integration tests for management commands: add, remove, upgrade.
 *
 * WHY: These commands modify asp-targets.toml and lock files, which are
 * critical operations that need end-to-end validation.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as path from 'node:path'

import { LOCK_FILENAME, readLockJson } from 'spaces-config'
import { install } from 'spaces-execution'

import { advancedRegistry, commitFor } from './advanced-registry.js'
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
