/**
 * Lock file generation from resolution results.
 *
 * WHY: Lock files ensure reproducible builds by recording
 * exact versions resolved during installation.
 */

import type {
  LockFile,
  LockPluginInfo,
  LockRegistry,
  LockSpaceEntry,
  LockTargetEntry,
  LockWarning,
  ResolvedFrom,
  Sha256Integrity,
  SpaceKey,
  SpaceRefString,
} from '@agent-spaces/core'
import { derivePluginIdentity } from '@agent-spaces/core'
import type { ClosureResult, ResolvedSpace } from './closure.js'
import { computeEnvHash, computeIntegrity } from './integrity.js'

/** Warning code for plugin name collisions */
const W205_PLUGIN_NAME_COLLISION = 'W205'

/**
 * Compute plugin name collision warnings for a target's load order.
 *
 * WHY: When multiple spaces produce the same plugin name, Claude may
 * load them incorrectly. We detect this during resolution so the
 * warning is stored in the lock file.
 */
function computePluginNameCollisions(
  loadOrder: SpaceKey[],
  allSpaces: Map<SpaceKey, ResolvedSpace>
): LockWarning[] {
  const warnings: LockWarning[] = []

  // Map plugin name -> list of space keys that produce it
  const pluginOwners = new Map<string, SpaceKey[]>()

  for (const key of loadOrder) {
    const space = allSpaces.get(key)
    if (!space) continue

    const identity = derivePluginIdentity(space.manifest)
    const pluginName = identity.name

    const owners = pluginOwners.get(pluginName) ?? []
    owners.push(key)
    pluginOwners.set(pluginName, owners)
  }

  // Report collisions
  for (const [pluginName, owners] of pluginOwners) {
    if (owners.length > 1) {
      const spaceIds = owners.map((key) => key.split('@')[0]).join(', ')
      warnings.push({
        code: W205_PLUGIN_NAME_COLLISION,
        message: `Plugin name '${pluginName}' is produced by multiple spaces: ${spaceIds}`,
        details: {
          pluginName,
          spaces: owners,
        },
      })
    }
  }

  return warnings
}

/**
 * Options for lock file generation.
 */
export interface LockGeneratorOptions {
  /** Working directory (registry repo root) */
  cwd: string
  /** Registry information */
  registry: LockRegistry
}

/**
 * Target resolution input.
 */
export interface TargetInput {
  /** Target name */
  name: string
  /** Original compose refs */
  compose: SpaceRefString[]
  /** Computed closure */
  closure: ClosureResult
}

// ============================================================================
// Lock Generation Helpers
// ============================================================================

/**
 * Build the selector string for resolvedFrom field.
 */
function buildResolvedFromSelector(resolvedFrom: ResolvedSpace['resolvedFrom']): string {
  if (resolvedFrom.selector.kind === 'dev') {
    return 'dev'
  }
  if (resolvedFrom.selector.kind === 'head') {
    return 'HEAD'
  }
  if (resolvedFrom.selector.kind === 'dist-tag') {
    return resolvedFrom.selector.tag
  }
  if (resolvedFrom.selector.kind === 'semver') {
    return resolvedFrom.selector.range
  }
  return `git:${resolvedFrom.selector.sha}`
}

/**
 * Build a LockSpaceEntry from a resolved space.
 */
function buildSpaceEntry(space: ResolvedSpace, integrity: Sha256Integrity): LockSpaceEntry {
  const pluginIdentity = derivePluginIdentity(space.manifest)

  const resolvedFrom: ResolvedFrom = {
    selector: buildResolvedFromSelector(space.resolvedFrom),
  }

  if (space.resolvedFrom.tag !== undefined) {
    resolvedFrom.tag = space.resolvedFrom.tag
  }
  if (space.resolvedFrom.semver !== undefined) {
    resolvedFrom.semver = space.resolvedFrom.semver
  }

  // Build plugin info, only including version if defined
  const pluginInfo: LockPluginInfo = { name: pluginIdentity.name }
  if (pluginIdentity.version !== undefined) {
    pluginInfo.version = pluginIdentity.version
  }

  return {
    id: space.id,
    commit: space.commit,
    path: space.path,
    integrity,
    plugin: pluginInfo,
    deps: {
      spaces: space.deps,
    },
    resolvedFrom,
  }
}

/**
 * Build a LockTargetEntry from a target input.
 */
function buildTargetEntry(
  target: TargetInput,
  allSpaces: Map<SpaceKey, ResolvedSpace>,
  integrities: Map<SpaceKey, Sha256Integrity>
): LockTargetEntry {
  // Build env hash data
  const envHashData = target.closure.loadOrder.map((key) => {
    const space = allSpaces.get(key)
    if (!space) throw new Error(`Space not found: ${key}`)
    const integrity = integrities.get(key)
    if (!integrity) throw new Error(`Integrity not computed for space: ${key}`)
    const pluginIdentity = derivePluginIdentity(space.manifest)
    return {
      spaceKey: key,
      integrity,
      pluginName: pluginIdentity.name,
    }
  })

  const envHash = computeEnvHash(envHashData)

  // Compute warnings for this target (W205 plugin name collisions)
  const warnings = computePluginNameCollisions(target.closure.loadOrder, allSpaces)

  const targetEntry: LockTargetEntry = {
    compose: target.compose,
    roots: target.closure.roots,
    loadOrder: target.closure.loadOrder,
    envHash,
  }

  // Only include warnings field if there are warnings
  if (warnings.length > 0) {
    targetEntry.warnings = warnings
  }

  return targetEntry
}

/**
 * Collect all unique spaces from targets and compute their integrities.
 */
async function collectSpacesAndIntegrities(
  targets: TargetInput[],
  options: LockGeneratorOptions
): Promise<{
  allSpaces: Map<SpaceKey, ResolvedSpace>
  integrities: Map<SpaceKey, Sha256Integrity>
}> {
  const allSpaces = new Map<SpaceKey, ResolvedSpace>()
  const integrities = new Map<SpaceKey, Sha256Integrity>()

  for (const target of targets) {
    for (const [key, space] of target.closure.spaces) {
      if (!allSpaces.has(key)) {
        allSpaces.set(key, space)
        const integrity = await computeIntegrity(space.id, space.commit, options)
        integrities.set(key, integrity)
      }
    }
  }

  return { allSpaces, integrities }
}

/**
 * Generate a complete lock file from resolved targets.
 */
export async function generateLockFile(
  targets: TargetInput[],
  options: LockGeneratorOptions
): Promise<LockFile> {
  const lock: LockFile = {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: new Date().toISOString(),
    registry: options.registry,
    spaces: {},
    targets: {},
  }

  // Collect all unique spaces and compute integrities
  const { allSpaces, integrities } = await collectSpacesAndIntegrities(targets, options)

  // Build space entries
  for (const [key, space] of allSpaces) {
    const integrity = integrities.get(key)
    if (!integrity) throw new Error(`Integrity not computed for space: ${key}`)
    lock.spaces[key] = buildSpaceEntry(space, integrity)
  }

  // Build target entries
  for (const target of targets) {
    lock.targets[target.name] = buildTargetEntry(target, allSpaces, integrities)
  }

  return lock
}

/**
 * Generate a lock file for a single target.
 */
export async function generateLockFileForTarget(
  targetName: string,
  compose: SpaceRefString[],
  closure: ClosureResult,
  options: LockGeneratorOptions
): Promise<LockFile> {
  return generateLockFile([{ name: targetName, compose, closure }], options)
}

/**
 * Merge a new lock file into an existing one.
 * Updates or adds targets while preserving existing ones.
 */
export function mergeLockFiles(existing: LockFile, updates: LockFile): LockFile {
  const merged: LockFile = {
    ...existing,
    generatedAt: new Date().toISOString(),
    spaces: { ...existing.spaces },
    targets: { ...existing.targets },
  }

  // Merge spaces (updates take precedence for same key)
  for (const [key, entry] of Object.entries(updates.spaces)) {
    merged.spaces[key as SpaceKey] = entry
  }

  // Merge targets (updates take precedence)
  for (const [name, entry] of Object.entries(updates.targets)) {
    merged.targets[name] = entry
  }

  return merged
}

/**
 * Check if a lock file is up to date for a target.
 * Returns true if the compose list matches exactly.
 */
export function isTargetUpToDate(
  lock: LockFile,
  targetName: string,
  compose: SpaceRefString[]
): boolean {
  const entry = lock.targets[targetName]
  if (!entry) {
    return false
  }

  if (entry.compose.length !== compose.length) {
    return false
  }

  return entry.compose.every((ref, i) => ref === compose[i])
}
