/**
 * Lock/store orchestration (install command).
 *
 * WHY: Orchestrates the full installation process:
 * - Parse targets from project manifest
 * - Resolve all space references
 * - Write lock file
 * - Populate store with space snapshots
 */

import { join } from 'node:path'

import {
  LOCK_FILENAME,
  type LockFile,
  atomicWriteJson,
  createEmptyLockFile,
  withProjectLock,
} from '@agent-spaces/core'

import { mergeLockFiles } from '@agent-spaces/resolver'

import {
  PathResolver,
  type SnapshotOptions,
  createSnapshot,
  ensureAspHome,
  getAspHome,
  snapshotExists,
} from '@agent-spaces/store'

import { fetch as gitFetch } from '@agent-spaces/git'

import {
  type ResolveOptions,
  type ResolveResult,
  getRegistryPath,
  loadLockFileIfExists,
  loadProjectManifest,
  resolveTarget,
} from './resolve.js'

/**
 * Options for install operation.
 */
export interface InstallOptions extends ResolveOptions {
  /** Whether to update existing lock (default: false) */
  update?: boolean | undefined
  /** Targets to install (default: all) */
  targets?: string[] | undefined
  /** Whether to fetch registry updates (default: true) */
  fetchRegistry?: boolean | undefined
}

/**
 * Result of install operation.
 */
export interface InstallResult {
  /** Updated lock file */
  lock: LockFile
  /** Number of new snapshots created */
  snapshotsCreated: number
  /** Targets that were resolved */
  resolvedTargets: string[]
  /** Path to written lock file */
  lockPath: string
}

/**
 * Ensure registry is available and up to date.
 */
export async function ensureRegistry(options: InstallOptions): Promise<string> {
  await ensureAspHome()

  const repoPath = getRegistryPath(options)

  // If fetchRegistry is enabled, update the repo
  if (options.fetchRegistry !== false) {
    try {
      await gitFetch('origin', { cwd: repoPath, all: true })
    } catch {
      // Repository may not exist yet, that's ok
    }
  }

  return repoPath
}

/**
 * Populate store with space snapshots from lock.
 */
export async function populateStore(lock: LockFile, options: InstallOptions): Promise<number> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = getRegistryPath(options)

  const snapshotOptions: SnapshotOptions = {
    paths,
    cwd: registryPath,
  }

  let created = 0

  for (const [_key, entry] of Object.entries(lock.spaces)) {
    // Check if snapshot already exists
    if (await snapshotExists(entry.integrity, snapshotOptions)) {
      continue
    }

    // Create snapshot from registry
    await createSnapshot(entry.id, entry.commit, snapshotOptions)

    created++
  }

  return created
}

/**
 * Write lock file atomically.
 */
export async function writeLockFile(lock: LockFile, projectPath: string): Promise<string> {
  const lockPath = join(projectPath, LOCK_FILENAME)
  await atomicWriteJson(lockPath, lock)
  return lockPath
}

/**
 * Install targets from project manifest.
 *
 * This:
 * 1. Loads project manifest
 * 2. Resolves all specified targets (or all if not specified)
 * 3. Merges resolution results into a lock file
 * 4. Populates store with space snapshots
 * 5. Writes lock file
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  // Ensure registry is available
  const registryPath = await ensureRegistry(options)

  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath)

  // Determine which targets to resolve
  const targetNames = options.targets ?? Object.keys(manifest.targets)

  if (targetNames.length === 0) {
    throw new Error('No targets found in project manifest')
  }

  // Resolve all targets
  const results: ResolveResult[] = []
  for (const name of targetNames) {
    const result = await resolveTarget(name, options)
    results.push(result)
  }

  // Merge lock files - start with empty and merge each result
  let mergedLock = createEmptyLockFile({
    type: 'git',
    url: registryPath,
  })
  for (const result of results) {
    mergedLock = mergeLockFiles(mergedLock, result.lock)
  }

  // Populate store with snapshots
  const snapshotsCreated = await populateStore(mergedLock, options)

  // Write lock file with project lock
  const lockPath = await withProjectLock(options.projectPath, async () => {
    return writeLockFile(mergedLock, options.projectPath)
  })

  return {
    lock: mergedLock,
    snapshotsCreated,
    resolvedTargets: targetNames,
    lockPath,
  }
}

/**
 * Check if install is needed (lock out of date).
 *
 * Compares the project manifest targets with the lock file.
 * Returns true if:
 * - Lock file doesn't exist
 * - Any target in manifest is missing from lock
 * - Any target's compose array differs
 */
export async function installNeeded(options: InstallOptions): Promise<boolean> {
  // Load lock file, if it doesn't exist, install is needed
  const existingLock = await loadLockFileIfExists(options.projectPath)
  if (!existingLock) {
    return true
  }

  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath)

  // Get targets to check (specific targets or all)
  const targetNames = options.targets ?? Object.keys(manifest.targets)

  for (const name of targetNames) {
    const target = manifest.targets[name]
    if (!target) {
      // Target doesn't exist in manifest (shouldn't happen but be safe)
      continue
    }

    const lockTarget = existingLock.targets[name]
    if (!lockTarget) {
      // Target not in lock file, install needed
      return true
    }

    // Compare compose arrays
    const manifestCompose = target.compose ?? []
    const lockCompose = lockTarget.compose ?? []

    if (manifestCompose.length !== lockCompose.length) {
      return true
    }

    for (let i = 0; i < manifestCompose.length; i++) {
      if (manifestCompose[i] !== lockCompose[i]) {
        return true
      }
    }
  }

  // All targets match, no install needed
  return false
}
