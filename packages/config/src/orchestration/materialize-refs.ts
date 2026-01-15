/**
 * Low-level materialization from explicit space refs.
 *
 * WHY: Provides a simpler entrypoint for programmatic materialization without
 * requiring an asp-targets.toml manifest. Used by both install() and external
 * consumers like control-plane.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'

import {
  type CommitSha,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessId,
  type LockFile,
  type SpaceId,
  type SpaceRefString,
  atomicWriteJson,
  lockFileExists,
  readLockJson,
} from '../core/index.js'

import {
  type ClosureOptions,
  DEV_COMMIT_MARKER,
  DEV_INTEGRITY,
  type LockGeneratorOptions,
  computeClosure,
  generateLockFileForTarget,
  mergeLockFiles,
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
import { type TargetMaterializationResult, materializeTarget } from './install.js'

/**
 * Skill metadata discovered from materialized plugins.
 */
export interface SkillMetadata {
  /** Skill name (derived from directory structure) */
  name: string
  /** Absolute path to SKILL.md file */
  sourcePath: string
  /** Plugin directory containing this skill */
  pluginDir: string
}

/**
 * Options for materializeFromRefs().
 */
export interface MaterializeFromRefsOptions {
  /** Target name (used as key in lock file) */
  targetName: string
  /** Space references to materialize */
  refs: SpaceRefString[]
  /** Path to registry git repository */
  registryPath: string
  /** ASP_HOME directory */
  aspHome?: string
  /** Path to lock file (read and write) */
  lockPath: string
  /** Pinned spaces (skip re-resolution) */
  pinnedSpaces?: Map<SpaceId, CommitSha>
  /** Harness to materialize for (default: 'claude') */
  harness?: HarnessId
  /** Harness adapter to use for materialization */
  adapter?: HarnessAdapter | undefined
  /** Whether to fetch registry updates (default: true) */
  fetchRegistry?: boolean
  /** Force refresh from source (default: false) */
  refresh?: boolean
  /** Project path for asp_modules output (default: dirname of lockPath) */
  projectPath?: string
}

/**
 * Result of materializeFromRefs().
 */
export interface MaterializeFromRefsResult {
  /** Generated/updated lock file */
  lock: LockFile
  /** Path where lock was written */
  lockPath: string
  /** Materialized plugin directories */
  pluginDirs: string[]
  /** Number of new snapshots created */
  snapshotsCreated: number
  /** Discovered skills with metadata */
  skills: SkillMetadata[]
  /** Full materialization result from harness */
  materialization: TargetMaterializationResult
}

/**
 * Materialize spaces from explicit refs without reading asp-targets.toml.
 *
 * This is the low-level helper that both install() and control-plane use.
 * It handles:
 * 1. Registry fetch (optional)
 * 2. Closure computation from refs
 * 3. Lock file generation
 * 4. Snapshot population
 * 5. Plugin materialization
 * 6. Skills discovery
 */
export async function materializeFromRefs(
  options: MaterializeFromRefsOptions
): Promise<MaterializeFromRefsResult> {
  const {
    targetName,
    refs,
    registryPath,
    lockPath,
    pinnedSpaces,
    harness = DEFAULT_HARNESS,
    fetchRegistry = true,
    refresh = false,
  } = options
  const adapter = options.adapter
  if (!adapter) {
    throw new Error(
      `materializeFromRefs requires an adapter. Use the execution package to get a harness adapter for '${harness}'.`
    )
  }

  const aspHome = options.aspHome ?? getAspHome()
  const projectPath = options.projectPath ?? dirname(lockPath)

  // Ensure ASP_HOME directories exist
  await ensureAspHome()

  // Optionally fetch registry updates
  if (fetchRegistry) {
    try {
      await gitFetch('origin', { cwd: registryPath, all: true })
    } catch {
      // Repository may not exist yet, that's ok
    }
  }

  // Load existing lock if available (for pinning)
  const existingLock = await loadLockIfExists(lockPath)
  const effectivePinnedSpaces = pinnedSpaces ?? extractPinnedSpaces(existingLock)

  // Compute closure from refs
  const closureOptions: ClosureOptions = {
    cwd: registryPath,
    pinnedSpaces: effectivePinnedSpaces,
  }
  const closure = await computeClosure(refs, closureOptions)

  // Generate lock file for target
  const lockOptions: LockGeneratorOptions = {
    cwd: registryPath,
    registry: {
      type: 'git',
      url: registryPath,
    },
  }
  const newLock = await generateLockFileForTarget(targetName, refs, closure, lockOptions)

  // Merge with existing lock if present (preserves other targets)
  let mergedLock: LockFile
  if (existingLock) {
    mergedLock = mergeLockFiles(existingLock, newLock)
  } else {
    mergedLock = newLock
  }

  // Populate store with snapshots
  const snapshotsCreated = await populateSnapshots(mergedLock, registryPath, aspHome)

  // Write lock file
  await ensureLockDir(lockPath)
  await atomicWriteJson(lockPath, mergedLock)

  // Materialize target using harness adapter
  const matOptions = {
    projectPath,
    aspHome,
    registryPath,
    harness,
    refresh,
    adapter,
  }
  const materialization = await materializeTarget(targetName, mergedLock, matOptions)

  // Discover skills from materialized plugins
  const skills = await discoverSkills(materialization.pluginDirs)

  return {
    lock: mergedLock,
    lockPath,
    pluginDirs: materialization.pluginDirs,
    snapshotsCreated,
    skills,
    materialization,
  }
}

/**
 * Load lock file if it exists at the given path.
 */
async function loadLockIfExists(lockPath: string): Promise<LockFile | null> {
  if (await lockFileExists(lockPath)) {
    return readLockJson(lockPath)
  }
  return null
}

/**
 * Extract pinned spaces from an existing lock file.
 */
function extractPinnedSpaces(lock: LockFile | null): Map<SpaceId, CommitSha> | undefined {
  if (!lock) return undefined

  const pinned = new Map<SpaceId, CommitSha>()
  for (const entry of Object.values(lock.spaces)) {
    // Skip dev entries
    if (entry.commit === DEV_COMMIT_MARKER || entry.integrity === DEV_INTEGRITY) {
      continue
    }
    pinned.set(entry.id as SpaceId, entry.commit as CommitSha)
  }

  return pinned.size > 0 ? pinned : undefined
}

/**
 * Ensure the directory for the lock file exists.
 */
async function ensureLockDir(lockPath: string): Promise<void> {
  const dir = dirname(lockPath)
  await mkdir(dir, { recursive: true })
}

/**
 * Populate store with space snapshots from lock.
 */
async function populateSnapshots(
  lock: LockFile,
  registryPath: string,
  aspHome: string
): Promise<number> {
  const paths = new PathResolver({ aspHome })
  const snapshotOptions: SnapshotOptions = {
    paths,
    cwd: registryPath,
  }

  let created = 0

  for (const entry of Object.values(lock.spaces)) {
    // Skip @dev entries - they use filesystem directly
    if (entry.commit === DEV_COMMIT_MARKER || entry.integrity === DEV_INTEGRITY) {
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
 * Discover SKILL.md files from plugin directories.
 */
export async function discoverSkills(pluginDirs: string[]): Promise<SkillMetadata[]> {
  const skills: SkillMetadata[] = []

  for (const pluginDir of pluginDirs) {
    const skillsDir = join(pluginDir, 'skills')
    if (!existsSync(skillsDir)) continue

    const files = await findSkillFiles(skillsDir)
    files.sort()

    for (const file of files) {
      const name = getSkillName(skillsDir, pluginDir, file)
      skills.push({ name, sourcePath: file, pluginDir })
    }
  }

  return skills
}

/**
 * Recursively find SKILL.md files under a directory.
 */
async function findSkillFiles(rootDir: string): Promise<string[]> {
  const results: string[] = []

  try {
    const entries = await readdir(rootDir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(rootDir, entry.name)
      if (entry.isDirectory()) {
        const nested = await findSkillFiles(fullPath)
        results.push(...nested)
      } else if (entry.isFile() && entry.name === 'SKILL.md') {
        results.push(fullPath)
      }
    }
  } catch {
    // Directory may not exist or be readable
  }

  return results
}

/**
 * Derive skill name from its path relative to the skills directory.
 */
function getSkillName(skillsDir: string, pluginDir: string, filePath: string): string {
  const rel = relative(skillsDir, filePath).split(sep).join('/')

  if (rel === 'SKILL.md') {
    // Root skill - use plugin directory name
    return basename(pluginDir)
  }

  if (rel.endsWith('/SKILL.md')) {
    // Nested skill - use path without SKILL.md
    return rel.slice(0, -'/SKILL.md'.length)
  }

  // Fallback
  return rel.replace(/SKILL\.md$/, '').replace(/\/$/, '')
}
