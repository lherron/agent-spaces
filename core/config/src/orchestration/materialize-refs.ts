/**
 * Low-level materialization from explicit space refs.
 *
 * WHY: Provides a simpler entrypoint for programmatic materialization without
 * requiring an asp-targets.toml manifest. Used by both install() and external
 * consumers like control-plane.
 */

import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

import type { CompileContext } from 'spaces-runtime-contracts'

import {
  type AgentLocalComponents,
  type CommitSha,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type LockFile,
  PORTABLE_SPACES_REGISTRY,
  type SpaceId,
  type SpaceRefString,
  atomicWriteJson,
  lockFileExists,
  readLockJson,
} from '../core/index.js'
// Internal legacy seam (EN-15986): the refs path addresses adapters by
// their pre-cutover ids. T-08702 deletes it with the v1 flow.
import type { HarnessId } from '../core/types/harness.js'

import {
  type ClosureOptions,
  type ImmutableSourceRoot,
  type LockGeneratorOptions,
  classifySpaceEntry,
  computeClosure,
  generateLockFileForTarget,
  mergeLockFiles,
  resolveImmutableSourceRoot,
} from '../resolver/index.js'

import { PathResolver, ensureAspHome, getAspHome } from '../store/index.js'

import { fetch as gitFetch } from '../git/index.js'
import { pathMarker, pathMarkerTimer } from '../path-markers/index.js'
import { type InstallOptions, populateSnapshotsFromLock } from './install.js'
import { withLockFileMerge } from './materialization-staging.js'
import { type TargetMaterializationResult, materializeTarget } from './materialize-target.js'

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
  /** Explicit node-local placement used only for immutable registry entries. */
  immutableRegistryPath?: ImmutableSourceRoot
  /** Path to lock file (read and write) */
  lockPath: string
  /** Pinned spaces (skip re-resolution) */
  pinnedSpaces?: Map<SpaceId, CommitSha>
  /** Harness to materialize for (default: 'claude') */
  harness?: HarnessId
  /** Harness adapter to use for materialization */
  adapter?: HarnessAdapter | undefined
  /**
   * Whether to fetch registry updates (default: true). The fetch runs only when
   * a registry space first reads `registryPath` itself.
   */
  fetchRegistry?: boolean
  /** Force refresh from source (default: false) */
  refresh?: boolean
  /** Inherit project-level settings during composition */
  inheritProject?: boolean
  /** Inherit user-level settings during composition */
  inheritUser?: boolean
  /** Project path used to derive the ASP_HOME bundle location (default: dirname of lockPath) */
  projectPath?: string
  /** Agent root directory for resolving space:agent:<id> refs */
  agentRoot?: string
  /** Project root directory for resolving space:project:<id> refs */
  projectRoot?: string
  /**
   * Agent-local components (skills/ and commands/ directories) detected at the agent root.
   * When present, a synthetic plugin artifact is appended to the target bundle.
   */
  agentLocalComponents?: AgentLocalComponents | undefined
  /** Semantic stable identity for agent/project placement materialization. */
  materializationIdentity?: InstallOptions['materializationIdentity'] | undefined
  /** Pinned compile clock; when supplied it, not the host clock, stamps lock/metadata timestamps. */
  compileContext?: CompileContext | undefined
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
 * Defer the registry `git fetch` until a registry space first reads the
 * repository it updates (T-11840). @dev, project and agent spaces never read
 * git, and fetching the shared root never updates a separate immutable root,
 * so compiles that only read either skip the network round trip entirely.
 */
function deferRegistryFetch(registryPath: string): {
  readonly ran: boolean
  before(root: ImmutableSourceRoot): ImmutableSourceRoot
} {
  let pending: Promise<void> | undefined
  return {
    get ran() {
      return pending !== undefined
    },
    before(root) {
      return async () => {
        const resolved = await resolveImmutableSourceRoot(root, registryPath)
        if (resolve(resolved) === resolve(registryPath)) {
          pending ??= (async () => {
            const fetched = pathMarkerTimer('materialize.registry-fetch')
            try {
              await gitFetch('origin', { cwd: registryPath, all: true })
              fetched('ok')
            } catch {
              // Repository may not exist yet, that's ok
              fetched('failed')
            }
          })()
          await pending
        }
        return resolved
      }
    },
  }
}

/**
 * Materialize spaces from explicit refs without reading asp-targets.toml.
 *
 * This is the low-level helper that both install() and control-plane use.
 * It handles:
 * 1. Registry fetch (optional, deferred to the first registry read)
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
  const registryFetch = fetchRegistry ? deferRegistryFetch(registryPath) : undefined
  const immutableRegistryPath = registryFetch
    ? registryFetch.before(options.immutableRegistryPath ?? registryPath)
    : (options.immutableRegistryPath ?? registryPath)

  // Ensure ASP_HOME directories exist
  await ensureAspHome()

  // Load existing lock if available (for pinning)
  const existingLock = await loadLockIfExists(lockPath)
  const effectivePinnedSpaces = pinnedSpaces ?? extractPinnedSpaces(existingLock)

  // Compute closure from refs
  const closureOptions: ClosureOptions = {
    cwd: registryPath,
    immutableCwd: immutableRegistryPath,
    pinnedSpaces: effectivePinnedSpaces,
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
  }
  const closure = await computeClosure(refs, closureOptions)

  // Generate lock file for target
  const lockOptions: LockGeneratorOptions = {
    cwd: registryPath,
    immutableCwd: immutableRegistryPath,
    registry: PORTABLE_SPACES_REGISTRY,
    ...(options.agentRoot ? { agentRoot: options.agentRoot } : {}),
    ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    compileContext: options.compileContext,
  }
  const newLock = await generateLockFileForTarget(targetName, refs, closure, lockOptions)

  // Populate store with snapshots
  const snapshotsCreated = await populateSnapshotsFromLock(
    existingLock ? mergeLockFiles(existingLock, newLock, options.compileContext) : newLock,
    immutableRegistryPath,
    aspHome
  )
  // Snapshot population is the last registry read: no fetch by now means none was needed.
  if (!registryFetch?.ran) pathMarker('materialize.registry-fetch', 'skipped')

  // Merge with the lock as it is now (preserves other targets, including ones
  // concurrent compiles wrote since the read above) and write it, under the
  // lock file's cross-process lock.
  const mergedLock = await withLockFileMerge(new PathResolver({ aspHome }), lockPath, async () => {
    const currentLock = await loadLockIfExists(lockPath)
    const merged = currentLock
      ? mergeLockFiles(currentLock, newLock, options.compileContext)
      : newLock
    pathMarker('materialize.lock-write', currentLock ? 'merged' : 'fresh')
    await ensureLockDir(lockPath)
    await atomicWriteJson(lockPath, merged)
    return merged
  })

  // Materialize target using harness adapter
  const matOptions = {
    projectPath,
    aspHome,
    registryPath,
    harness,
    refresh,
    adapter,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    ...(options.agentRoot ? { agentPath: options.agentRoot } : {}),
    ...(options.agentLocalComponents ? { agentLocalComponents: options.agentLocalComponents } : {}),
    ...(options.materializationIdentity
      ? { materializationIdentity: options.materializationIdentity }
      : {}),
  }
  const materialization = await materializeTarget(targetName, mergedLock, matOptions)

  // Discover skills from materialized plugins (includes collision detection)
  const skills = await discoverSkills(materialization.pluginDirs)

  // Detect command name collisions across plugins
  await detectCommandConflicts(materialization.pluginDirs)

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
    if (classifySpaceEntry(entry) === 'dev') {
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
 * Record an owner for `name` in `seen`, throwing on a second insert.
 *
 * The thrown message is produced by `conflictMessage(existingOwner)` so each
 * caller keeps its exact wording (skill vs command).
 */
function assertNoNameCollision<T>(
  seen: Map<string, T>,
  name: string,
  owner: T,
  conflictMessage: (existingOwner: T) => string
): void {
  const existing = seen.get(name)
  if (existing !== undefined) {
    throw new Error(conflictMessage(existing))
  }
  seen.set(name, owner)
}

/**
 * Discover SKILL.md files from plugin directories.
 *
 * Checks for name collisions across plugins — if the same skill name
 * appears in two different plugin directories, an error is thrown.
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

  // Check for name collisions across plugins
  const seen = new Map<string, SkillMetadata>()
  for (const skill of skills) {
    assertNoNameCollision(
      seen,
      skill.name,
      skill,
      (existing) =>
        `Skill name conflict: "${skill.name}" exists in both ` +
        `${basename(existing.pluginDir)} and ${basename(skill.pluginDir)}`
    )
  }

  return skills
}

/**
 * Detect command name collisions across plugin directories.
 *
 * Commands are `.md` files directly inside `commands/` directories.
 * If the same command name appears in two different plugins, an error is thrown.
 */
export async function detectCommandConflicts(pluginDirs: string[]): Promise<void> {
  const seen = new Map<string, string>() // name → pluginDir basename

  for (const pluginDir of pluginDirs) {
    const commandsDir = join(pluginDir, 'commands')
    if (!existsSync(commandsDir)) continue

    const entries = await readdir(commandsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue
      const name = entry.name.replace(/\.md$/, '')
      assertNoNameCollision(
        seen,
        name,
        basename(pluginDir),
        (existing) =>
          `Command name conflict: "${name}" exists in both ` +
          `${existing} and ${basename(pluginDir)}`
      )
    }
  }
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
