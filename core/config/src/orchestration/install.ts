/**
 * Lock/store orchestration (install command).
 *
 * WHY: Orchestrates the full installation process:
 * - Parse targets from project manifest
 * - Resolve all space references
 * - Write lock file
 * - Populate store with space snapshots
 * - Materialize composed bundles under ASP_HOME
 */

import { join } from 'node:path'

import {
  type AgentLocalComponents,
  type CommitSha,
  type HarnessAdapter,
  LOCK_FILENAME,
  type LockFile,
  PORTABLE_SPACES_REGISTRY,
  type SpaceId,
  type SpaceKey,
  atomicWriteJson,
  createEmptyLockFile,
  withProjectLock,
} from '../core/index.js'
// Internal legacy seam (EN-15986): the install path addresses adapters by
// their pre-cutover ids. T-08702 deletes it with the v1 flow.
import type { HarnessId } from '../core/types/harness.js'

import {
  type ImmutableSourceRoot,
  classifySpaceEntry,
  mergeLockFiles,
  resolveImmutableSourceRoot,
  resolveSpaceContentDir,
} from '../resolver/index.js'

import {
  PathResolver,
  type SnapshotOptions,
  createSnapshot,
  ensureAspHome,
  getAspHome,
  snapshotExists,
} from '../store/index.js'

import { fetch as gitFetch } from '../git/index.js'
import {
  type LintContext,
  type LintWarning,
  type SpaceLintData,
  WARNING_CODES,
  formatWarnings,
  lint as lintSpaces,
} from '../lint/index.js'

import { type TargetMaterializationResult, materializeTarget } from './materialize-target.js'
import {
  type ResolveOptions,
  type ResolveResult,
  deferImmutableRegistry,
  getRegistryPath,
  loadLockFileIfExists,
  loadProjectManifest,
  refreshImmutableRegistryIfPresent,
  resolveTarget,
} from './resolve.js'

/**
 * Options for install operation.
 */
export interface InstallOptions extends ResolveOptions {
  /** Harness to install for (default: 'claude') */
  harness?: HarnessId | undefined
  /** Harness adapter to use for materialization. Required for materializeTarget. */
  adapter?: HarnessAdapter | undefined
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
  /**
   * Inherit project-level settings (for Pi: enables .pi/skills in project).
   * Maps to --inherit-project CLI flag.
   */
  inheritProject?: boolean | undefined
  /**
   * Inherit user-level settings (for Pi: enables ~/.pi/agent/skills).
   * Maps to --inherit-user CLI flag.
   */
  inheritUser?: boolean | undefined
  /**
   * Agent-local components (skills/ and commands/ directories) detected at the agent root.
   * When present, a synthetic plugin artifact is appended to the target bundle.
   */
  agentLocalComponents?: AgentLocalComponents | undefined
  /**
   * Semantic stable identity for agent/project placements. When present, this
   * drives the public codex-homes/<project>_<agent> scope path instead of cwd
   * basenames.
   */
  materializationIdentity?:
    | {
        agentId: string
        projectId: string
        frontend?: string | undefined
      }
    | undefined
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

  if (options.fetchRegistry !== false) {
    await refreshImmutableRegistryIfPresent(options)
  }

  return repoPath
}

/**
 * Populate store with the registry-backed snapshots referenced by a lock.
 *
 * Shared core behind both {@link populateStore} (install path) and the
 * materialize-from-refs path; returns the number of snapshots created.
 */
export async function populateSnapshotsFromLock(
  lock: LockFile,
  registryPath: ImmutableSourceRoot,
  aspHome: string
): Promise<number> {
  const paths = new PathResolver({ aspHome })
  // Placed on the first snapshot that must be created; filesystem-backed and
  // already-snapshotted entries never acquire the immutable mirror.
  let snapshotOptions: SnapshotOptions | undefined

  let created = 0

  for (const entry of Object.values(lock.spaces)) {
    // Skip filesystem-backed entries (@dev / project / agent) — no snapshot needed
    if (classifySpaceEntry(entry) !== 'registry') {
      continue
    }

    // Check if snapshot already exists
    if (await snapshotExists(entry.integrity, { paths })) {
      continue
    }

    snapshotOptions ??= { paths, cwd: await resolveImmutableSourceRoot(registryPath, '') }

    // Create snapshot from registry
    await createSnapshot(entry.id, entry.commit, snapshotOptions)

    created++
  }

  return created
}

/**
 * Populate store with space snapshots from lock.
 */
export async function populateStore(lock: LockFile, options: InstallOptions): Promise<number> {
  const aspHome = options.aspHome ?? getAspHome()
  const immutableRegistryPath = deferImmutableRegistry(options, { fetch: false })
  return populateSnapshotsFromLock(lock, immutableRegistryPath, aspHome)
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
 * Combine a partial resolution with the existing lock.
 *
 * Targets in `resolvedTargets` take their entries from `resolved`; every other
 * manifest target keeps its existing lock entry unchanged. Space entries are
 * the ones some kept target references, preferring the freshly resolved entry
 * when a key is shared. Targets no longer in the manifest are dropped, as a
 * full install would drop them.
 */
function keepUnresolvedTargets(
  existing: LockFile | null,
  resolved: LockFile,
  manifestTargets: string[],
  resolvedTargets: string[]
): LockFile {
  if (!existing) return resolved
  const resolvedSet = new Set(resolvedTargets)
  const targets: LockFile['targets'] = {}
  for (const name of manifestTargets) {
    const entry = resolvedSet.has(name) ? resolved.targets[name] : existing.targets[name]
    if (entry) targets[name] = entry
  }
  const spaces: LockFile['spaces'] = {}
  for (const entry of Object.values(targets)) {
    for (const key of [...entry.roots, ...entry.loadOrder]) {
      const space = resolved.spaces[key] ?? existing.spaces[key]
      if (space && !spaces[key]) spaces[key] = space
    }
  }
  return { ...resolved, spaces, targets }
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
 * 6. Materializes composed bundles under ASP_HOME
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  // Ensure registry is available
  const registryPath = await ensureRegistry(options)

  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)

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
  let mergedLock = createEmptyLockFile(PORTABLE_SPACES_REGISTRY, options.compileContext)
  for (const result of results) {
    mergedLock = mergeLockFiles(mergedLock, result.lock, options.compileContext)
  }

  // Populate store with snapshots
  const snapshotsCreated = await populateStore(mergedLock, options)

  // Run lint checks (halt on errors)
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const lintData: SpaceLintData[] = Object.entries(mergedLock.spaces).map(([key, entry]) => {
    const pluginPath = resolveSpaceContentDir(classifySpaceEntry(entry), entry, {
      agentPath: options.agentPath,
      projectPath: options.projectPath,
      registryPath,
      paths,
    })
    return {
      key: key as SpaceKey,
      manifest: {
        schema: 1 as const,
        id: entry.id,
        plugin: entry.plugin,
      },
      pluginPath,
    }
  })
  const lintContext: LintContext = { spaces: lintData }
  const lintWarnings: LintWarning[] = await lintSpaces(lintContext)
  const skillErrors = lintWarnings.filter(
    (warning) => warning.code === WARNING_CODES.SKILL_MD_MISSING_FRONTMATTER
  )
  if (skillErrors.length > 0) {
    const formatted = formatWarnings(skillErrors)
    throw new Error(`Skill lint errors found:\n${formatted}`)
  }

  // Write lock file with project lock. A partial install (explicit targets)
  // replaces only those targets' entries; every other target keeps its lock.
  const lockPath = await withProjectLock(options.projectPath, async () => {
    if (options.targets) {
      const existingLock = await loadLockFileIfExists(options.projectPath)
      mergedLock = keepUnresolvedTargets(
        existingLock,
        mergedLock,
        Object.keys(manifest.targets),
        targetNames
      )
    }
    return writeLockFile(mergedLock, options.projectPath)
  })

  // Materialize each target to the ASP_HOME project bundle directory
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
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)

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
