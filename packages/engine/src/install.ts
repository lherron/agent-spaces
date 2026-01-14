/**
 * Lock/store orchestration (install command).
 *
 * WHY: Orchestrates the full installation process:
 * - Parse targets from project manifest
 * - Resolve all space references
 * - Write lock file
 * - Populate store with space snapshots
 * - Materialize plugins to asp_modules directory
 */

import { join } from 'node:path'

import {
  type CommitSha,
  type ComposeTargetInput,
  DEFAULT_HARNESS,
  type HarnessId,
  LOCK_FILENAME,
  type LockFile,
  type MaterializeSpaceInput,
  type ResolvedSpaceArtifact,
  type ResolvedSpaceManifest,
  type Sha256Integrity,
  type SpaceId,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  atomicWriteJson,
  createEmptyLockFile,
  getAspModulesPath,
  getLoadOrderEntries,
  readSpaceToml,
  withProjectLock,
} from 'spaces-core'

import { DEV_COMMIT_MARKER, DEV_INTEGRITY, mergeLockFiles } from 'spaces-resolver'

import {
  PathResolver,
  type SnapshotOptions,
  cacheExists,
  computePluginCacheKey,
  createSnapshot,
  ensureAspHome,
  getAspHome,
  snapshotExists,
  writeCacheMetadata,
} from 'spaces-store'

import { fetch as gitFetch } from 'spaces-git'

import {
  type ResolveOptions,
  type ResolveResult,
  getRegistryPath,
  loadLockFileIfExists,
  loadProjectManifest,
  resolveTarget,
} from './resolve.js'

import { harnessRegistry } from './harness/index.js'

/**
 * Options for install operation.
 */
export interface InstallOptions extends ResolveOptions {
  /** Harness to install for (default: 'claude') */
  harness?: HarnessId | undefined
  /** Whether to update existing lock (default: false) */
  update?: boolean | undefined
  /** Targets to install (default: all) */
  targets?: string[] | undefined
  /** Whether to fetch registry updates (default: true) */
  fetchRegistry?: boolean | undefined
  /**
   * Space IDs to upgrade (default: all spaces).
   * When specified with update=true, only these spaces will be re-resolved
   * to their latest versions matching selectors. All other spaces will
   * keep their currently locked versions.
   */
  upgradeSpaceIds?: string[] | undefined
  /**
   * Force refresh from source (default: false).
   * Clears plugin cache and re-materializes all spaces from source.
   * Useful when source files have changed and you want to update the cache.
   */
  refresh?: boolean | undefined
}

/**
 * Result of materializing a single target.
 */
export interface TargetMaterializationResult {
  /** Target name */
  target: string
  /** Path to the target's output directory (asp_modules/<target>/) */
  outputPath: string
  /** Paths to materialized plugin directories */
  pluginDirs: string[]
  /** Path to composed MCP config (if any) */
  mcpConfigPath?: string | undefined
  /** Path to composed settings.json (if any) */
  settingsPath?: string | undefined
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
  /** Materialization results per target */
  materializations: TargetMaterializationResult[]
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
    // Skip @dev entries - they use filesystem directly, no snapshot needed
    if (entry.commit === (DEV_COMMIT_MARKER as string) || entry.integrity === DEV_INTEGRITY) {
      continue
    }

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
 * Materialize a single target to asp_modules directory.
 *
 * Uses the harness adapter's two-phase approach:
 * 1. materializeSpace() - Creates plugin artifacts with harness-specific transforms
 * 2. composeTarget() - Assembles artifacts into the target bundle
 */
export async function materializeTarget(
  targetName: string,
  lock: LockFile,
  options: InstallOptions
): Promise<TargetMaterializationResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = getRegistryPath(options)

  // Get harness adapter (default to claude)
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)

  // Get output paths using harness adapter
  // Returns: asp_modules/<target>/claude for ClaudeAdapter
  const aspModulesDir = getAspModulesPath(options.projectPath)
  const outputPath = adapter.getTargetOutputPath(aspModulesDir, targetName)

  // Get spaces in load order for this target (from lock)
  const entries = getLoadOrderEntries(lock, targetName)

  // Phase 1: Materialize each space using the harness adapter
  // This handles harness-specific transforms like hooks.toml → hooks.json for Claude
  const artifacts: ResolvedSpaceArtifact[] = []
  const settingsInputs: SpaceSettings[] = []

  for (const entry of entries) {
    const isDev =
      entry.commit === (DEV_COMMIT_MARKER as string) || entry.integrity === DEV_INTEGRITY

    // Compute cache key
    const pluginName = entry.plugin?.name ?? entry.id
    const pluginVersion = entry.plugin?.version ?? '0.0.0'
    const cacheKey = computePluginCacheKey(
      entry.integrity as Sha256Integrity,
      pluginName,
      pluginVersion
    )
    const cacheDir = paths.pluginCache(cacheKey)

    // Build space key
    const spaceKey = isDev
      ? (`${entry.id}@dev` as SpaceKey)
      : (`${entry.id}@${entry.commit.slice(0, 12)}` as SpaceKey)

    // Build snapshot path
    const snapshotPath = isDev
      ? join(registryPath, 'spaces', entry.id)
      : paths.snapshot(entry.integrity)

    // Read manifest for settings and harness support filtering
    let manifest: ResolvedSpaceManifest | undefined
    try {
      const spaceTomlPath = join(snapshotPath, 'space.toml')
      const parsed = await readSpaceToml(spaceTomlPath)
      manifest = {
        ...parsed,
        schema: 1,
        id: entry.id,
        plugin: {
          ...parsed.plugin,
          name: pluginName,
          version: pluginVersion,
        },
      } as ResolvedSpaceManifest
    } catch {
      manifest = undefined
    }

    const supports = manifest?.harness?.supports
    if (supports && !supports.includes(harnessId)) {
      // Skip spaces that do not support the selected harness
      continue
    }

    // Check cache (skip for @dev refs since content can change, or when refresh requested)
    const isCached = !isDev && !options.refresh && (await cacheExists(cacheKey, { paths }))

    if (!isCached) {
      // Build input for harness adapter
      const input: MaterializeSpaceInput = {
        spaceKey,
        manifest:
          manifest ??
          ({
            schema: 1,
            id: entry.id,
            plugin: {
              ...entry.plugin,
              name: pluginName,
              version: pluginVersion,
            },
          } as ResolvedSpaceManifest),
        snapshotPath,
        integrity: entry.integrity,
      }

      // Materialize using harness adapter (handles hooks.toml → hooks.json, etc.)
      // In dev mode, use copy instead of hardlinks to protect source files
      await adapter.materializeSpace(input, cacheDir, { force: true, useHardlinks: !isDev })

      // Write cache metadata
      await writeCacheMetadata(
        cacheKey,
        {
          pluginName,
          pluginVersion,
          integrity: entry.integrity as Sha256Integrity,
          cacheKey,
          createdAt: new Date().toISOString(),
          spaceKey,
        },
        { paths }
      )
    }

    // Collect artifact
    artifacts.push({
      spaceKey,
      spaceId: entry.id,
      artifactPath: cacheDir,
      pluginName,
      pluginVersion,
    })

    // Read settings from snapshot's space.toml for composition
    if (manifest?.settings) {
      settingsInputs.push(manifest.settings)
    } else {
      settingsInputs.push({})
    }
  }

  // Phase 2: Compose target using harness adapter
  // This handles assembling artifacts into the final target bundle
  const target = lock.targets[targetName]
  const composeInput: ComposeTargetInput = {
    targetName,
    compose: (target?.compose ?? []) as SpaceRefString[],
    roots: (target?.roots ?? []) as SpaceKey[],
    loadOrder: (target?.loadOrder ?? []) as SpaceKey[],
    artifacts,
    settingsInputs,
  }

  const { bundle } = await adapter.composeTarget(composeInput, outputPath, { clean: true })

  return {
    target: targetName,
    outputPath: bundle.rootDir,
    pluginDirs: bundle.pluginDirs ?? [],
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
  }
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
 * 6. Materializes plugins to asp_modules directory
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

  // Build pinnedSpaces map for selective upgrades
  // When upgradeSpaceIds is specified, we only re-resolve those spaces
  // and keep all others at their currently locked versions
  let pinnedSpaces: Map<SpaceId, CommitSha> | undefined
  if (options.update && options.upgradeSpaceIds && options.upgradeSpaceIds.length > 0) {
    const existingLock = await loadLockFileIfExists(options.projectPath)
    if (existingLock) {
      pinnedSpaces = new Map()
      const upgradeSet = new Set(options.upgradeSpaceIds)

      // For each space in the lock that is NOT being upgraded, pin it
      for (const [_key, entry] of Object.entries(existingLock.spaces)) {
        if (!upgradeSet.has(entry.id)) {
          pinnedSpaces.set(entry.id as SpaceId, entry.commit as CommitSha)
        }
      }
    }
  }

  // Build resolve options with pinnedSpaces
  const resolveOptions = { ...options, pinnedSpaces }

  // Resolve all targets
  const results: ResolveResult[] = []
  for (const name of targetNames) {
    const result = await resolveTarget(name, resolveOptions)
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

  // Materialize each target to asp_modules directory
  const materializations: TargetMaterializationResult[] = []
  for (const targetName of targetNames) {
    const matResult = await materializeTarget(targetName, mergedLock, options)
    materializations.push(matResult)
  }

  return {
    lock: mergedLock,
    snapshotsCreated,
    resolvedTargets: targetNames,
    lockPath,
    materializations,
  }
}

// ============================================================================
// Install Need Helpers
// ============================================================================

/**
 * Check if two compose arrays match.
 */
function composeArraysMatch(manifestCompose: string[], lockCompose: string[]): boolean {
  if (manifestCompose.length !== lockCompose.length) {
    return false
  }
  return manifestCompose.every((ref, i) => ref === lockCompose[i])
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
    if (!target) continue

    const lockTarget = existingLock.targets[name]
    if (!lockTarget) {
      return true
    }

    const manifestCompose = target.compose ?? []
    const lockCompose = lockTarget.compose ?? []
    if (!composeArraysMatch(manifestCompose, lockCompose)) {
      return true
    }
  }

  return false
}
