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

import { mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type CommitSha,
  DEFAULT_HARNESS,
  type HarnessId,
  LOCK_FILENAME,
  type LockFile,
  type SpaceId,
  type SpaceKey,
  atomicWriteJson,
  createEmptyLockFile,
  getAspModulesPath,
  getLoadOrderEntries,
  readSpaceToml,
  withProjectLock,
} from '@agent-spaces/core'

import { DEV_COMMIT_MARKER, DEV_INTEGRITY, mergeLockFiles } from '@agent-spaces/resolver'

import {
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  materializeSpaces,
} from '@agent-spaces/materializer'

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
  const pluginsPath = join(outputPath, 'plugins')

  // Clean and create output directory
  await rm(outputPath, { recursive: true, force: true }).catch(() => {})
  await mkdir(outputPath, { recursive: true })
  await mkdir(pluginsPath, { recursive: true })

  // Get spaces in load order for this target (from lock)
  const entries = getLoadOrderEntries(lock, targetName)

  // Build materialization inputs from locked spaces
  const inputs = entries.map((entry) => {
    const isDev =
      entry.commit === (DEV_COMMIT_MARKER as string) || entry.integrity === DEV_INTEGRITY

    return {
      manifest: {
        schema: 1 as const,
        id: entry.id,
        plugin: entry.plugin,
      },
      // @dev entries: use filesystem path; others: use snapshots
      snapshotPath: isDev
        ? join(registryPath, 'spaces', entry.id)
        : paths.snapshot(entry.integrity),
      spaceKey: isDev
        ? (`${entry.id}@dev` as SpaceKey)
        : (`${entry.id}@${entry.commit.slice(0, 12)}` as SpaceKey),
      integrity: entry.integrity,
    }
  })

  // Materialize all spaces (to cache)
  const materializeResults = await materializeSpaces(inputs, { paths })

  // Get plugin directories (in cache) and create symlinks in asp_modules
  // Use numeric prefixes to preserve load order (e.g., "000-base", "001-frontend")
  const pluginDirs: string[] = []
  for (let i = 0; i < materializeResults.length; i++) {
    const result = materializeResults[i]
    if (!result) continue

    const spaceId = result.spaceKey.split('@')[0] ?? result.spaceKey
    const prefix = String(i).padStart(3, '0')
    const linkPath = join(pluginsPath, `${prefix}-${spaceId}`)

    // Remove existing link/dir if present
    await rm(linkPath, { recursive: true, force: true }).catch(() => {})

    // Create symlink to cache
    await symlink(result.pluginPath, linkPath)

    pluginDirs.push(linkPath)
  }

  // Compose MCP configuration if any spaces have MCP
  let mcpConfigPath: string | undefined
  const mcpOutputPath = join(outputPath, 'mcp.json')
  const spacesDirs = materializeResults.map((r) => ({
    spaceId: r.spaceKey.split('@')[0] ?? r.spaceKey,
    dir: r.pluginPath,
  }))
  const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
  if (Object.keys(mcpResult.config.mcpServers).length > 0) {
    mcpConfigPath = mcpOutputPath
  }

  // Compose settings from all spaces
  const settingsOutputPath = join(outputPath, 'settings.json')
  const settingsInputs: SettingsInput[] = []

  // Read settings from each snapshot's space.toml
  for (const input of inputs) {
    try {
      const spaceTomlPath = join(input.snapshotPath, 'space.toml')
      const manifest = await readSpaceToml(spaceTomlPath)
      if (manifest.settings) {
        settingsInputs.push({
          spaceId: input.manifest.id,
          settings: manifest.settings,
        })
      }
    } catch {
      // Space.toml may not exist or may not have settings - that's fine
    }
  }

  await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
  const settingsPath = settingsOutputPath

  return {
    target: targetName,
    outputPath,
    pluginDirs,
    mcpConfigPath,
    settingsPath,
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
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Install orchestrates multiple steps
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
