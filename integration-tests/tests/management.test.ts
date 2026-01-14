/**
 * Integration tests for management commands: add, remove, upgrade.
 *
 * WHY: These commands modify asp-targets.toml and lock files, which are
 * critical operations that need end-to-end validation.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import { LOCK_FILENAME, readLockJson, readTargetsToml } from 'spaces-core'
import { install } from 'spaces-engine'

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

/**
 * Add a space to asp-targets.toml.
 * Mimics what the CLI add command does.
 */
async function addSpaceToTarget(
  projectPath: string,
  spaceRef: string,
  targetName: string,
  options?: { runInstall?: boolean; registryPath?: string; aspHome?: string }
): Promise<void> {
  const targetsPath = path.join(projectPath, 'asp-targets.toml')
  const manifest = await readTargetsToml(targetsPath)

  const target = manifest.targets[targetName]
  if (!target) {
    throw new Error(`Target "${targetName}" not found`)
  }

  // Check if already present
  if (target.compose.includes(spaceRef as never)) {
    return
  }

  // Add space
  target.compose.push(spaceRef as never)

  // Serialize back
  let toml = `schema = ${manifest.schema}\n\n`
  for (const [name, t] of Object.entries(manifest.targets)) {
    toml += `[targets.${name}]\n`
    if (t.description) {
      toml += `description = "${t.description}"\n`
    }
    toml += 'compose = [\n'
    for (const ref of t.compose) {
      toml += `  "${ref}",\n`
    }
    toml += ']\n\n'
  }

  await fs.writeFile(targetsPath, toml)

  // Run install if requested
  if (options?.runInstall !== false) {
    await install({
      projectPath,
      aspHome: options?.aspHome,
      registryPath: options?.registryPath,
      targets: [targetName],
    })
  }
}

/**
 * Remove a space from asp-targets.toml.
 * Mimics what the CLI remove command does.
 */
async function removeSpaceFromTarget(
  projectPath: string,
  spaceId: string,
  targetName: string,
  options?: { runInstall?: boolean; registryPath?: string; aspHome?: string }
): Promise<number> {
  const targetsPath = path.join(projectPath, 'asp-targets.toml')
  const manifest = await readTargetsToml(targetsPath)

  const target = manifest.targets[targetName]
  if (!target) {
    throw new Error(`Target "${targetName}" not found`)
  }

  const originalLength = target.compose.length

  // Filter out matching space refs
  target.compose = target.compose.filter((ref) => {
    const match = ref.match(/^space:([^@]+)@/)
    const refId = match ? match[1] : ref
    return refId !== spaceId
  })

  if (target.compose.length === originalLength) {
    return 0
  }

  // Serialize back
  let toml = `schema = ${manifest.schema}\n\n`
  for (const [name, t] of Object.entries(manifest.targets)) {
    toml += `[targets.${name}]\n`
    if (t.description) {
      toml += `description = "${t.description}"\n`
    }
    toml += 'compose = [\n'
    for (const ref of t.compose) {
      toml += `  "${ref}",\n`
    }
    toml += ']\n\n'
  }

  await fs.writeFile(targetsPath, toml)

  // Run install if requested
  if (options?.runInstall !== false && target.compose.length > 0) {
    await install({
      projectPath,
      aspHome: options?.aspHome,
      registryPath: options?.registryPath,
      targets: [targetName],
    })
  }

  return originalLength - target.compose.length
}

describe('asp add', () => {
  let aspHome: string
  let projectDir: string

  beforeEach(async () => {
    aspHome = await createTempAspHome()
    projectDir = await createTempProject({
      dev: {
        description: 'Development environment',
        compose: ['space:frontend@stable'],
      },
    })
  })

  afterEach(async () => {
    await cleanupTempAspHome(aspHome)
    await cleanupTempProject(projectDir)
  })

  test('adds a space to an existing target', async () => {
    // Add backend to dev target
    await addSpaceToTarget(projectDir, 'space:backend@stable', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Verify compose was updated
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    expect(manifest.targets.dev.compose).toContain('space:backend@stable')

    // Verify lock file was updated
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(lock.targets.dev.loadOrder.some((key) => key.startsWith('backend@'))).toBe(true)
  })

  test('does not duplicate existing space', async () => {
    // First add
    await addSpaceToTarget(projectDir, 'space:backend@stable', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    // Second add (should be no-op)
    await addSpaceToTarget(projectDir, 'space:backend@stable', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      runInstall: false,
    })

    // Verify only one entry
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    const backendCount = manifest.targets.dev.compose.filter((r) => r.includes('backend')).length
    expect(backendCount).toBe(1)
  })

  test('can skip install after adding', async () => {
    await addSpaceToTarget(projectDir, 'space:backend@stable', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      runInstall: false,
    })

    // Verify compose was updated
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    expect(manifest.targets.dev.compose).toContain('space:backend@stable')

    // Verify no lock file was created (since we skipped install)
    const lockExists = await fs
      .access(path.join(projectDir, 'asp-lock.json'))
      .then(() => true)
      .catch(() => false)
    expect(lockExists).toBe(false)
  })
})

describe('asp remove', () => {
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

  test('removes a space from a target', async () => {
    // Remove backend from dev
    const removed = await removeSpaceFromTarget(projectDir, 'backend', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(removed).toBe(1)

    // Verify compose was updated
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    expect(manifest.targets.dev.compose).not.toContain('space:backend@stable')

    // Verify lock file was updated
    const lock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    expect(lock.targets.dev.loadOrder.some((key) => key.startsWith('backend@'))).toBe(false)
  })

  test('returns 0 when space not found', async () => {
    const removed = await removeSpaceFromTarget(projectDir, 'nonexistent', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      runInstall: false,
    })

    expect(removed).toBe(0)
  })

  test('removes all versions of a space by ID', async () => {
    // Add another version of frontend
    await addSpaceToTarget(projectDir, 'space:frontend@latest', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      runInstall: false,
    })

    // Remove all frontend refs
    const removed = await removeSpaceFromTarget(projectDir, 'frontend', 'dev', {
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
    })

    expect(removed).toBe(2)

    // Verify compose no longer has frontend
    const manifest = await readTargetsToml(path.join(projectDir, 'asp-targets.toml'))
    expect(manifest.targets.dev.compose.some((r) => r.includes('frontend'))).toBe(false)
  })
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

  test('upgrades lock file with update flag', async () => {
    // Get current lock
    const oldLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const oldFrontendEntry = Object.entries(oldLock.spaces).find(([key]) =>
      key.startsWith('frontend@')
    )
    expect(oldFrontendEntry).toBeDefined()

    // Run install with update=true (simulates upgrade)
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      update: true,
    })

    // Get new lock
    const newLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))
    const newFrontendEntry = Object.entries(newLock.spaces).find(([key]) =>
      key.startsWith('frontend@')
    )
    expect(newFrontendEntry).toBeDefined()

    // Both should be valid (using stable dist-tag)
    expect(newFrontendEntry?.[1].plugin.version).toBeDefined()
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

    // Upgrade only frontend
    await install({
      projectPath: projectDir,
      registryPath: SAMPLE_REGISTRY_DIR,
      aspHome,
      update: true,
      upgradeSpaceIds: ['frontend'],
    })

    const newLock = await readLockJson(path.join(projectDir, LOCK_FILENAME))

    // Backend should remain unchanged (same commit)
    const oldBackend = Object.entries(oldLock.spaces).find(([key]) => key.startsWith('backend@'))
    const newBackend = Object.entries(newLock.spaces).find(([key]) => key.startsWith('backend@'))

    expect(oldBackend).toBeDefined()
    expect(newBackend).toBeDefined()
    expect(oldBackend?.[1].commit).toBe(newBackend?.[1].commit)
  })
})
