/**
 * High-level resolution entrypoints.
 *
 * WHY: Provides a simplified interface for resolving targets from project
 * manifests, abstracting the resolver package's lower-level APIs.
 */

import {
  type LockFile,
  type ProjectManifest,
  type TargetDefinition,
  getTarget,
  lockFileExists,
  readLockJson,
  readTargetsToml,
} from '@agent-spaces/core'

import {
  type ClosureOptions,
  type ClosureResult,
  type LockGeneratorOptions,
  type ResolvedSpace,
  computeClosure,
  generateLockFileForTarget,
} from '@agent-spaces/resolver'

import { PathResolver, getAspHome } from '@agent-spaces/store'

/**
 * Options for resolving a target.
 */
export interface ResolveOptions {
  /** Path to project directory (contains asp-targets.toml) */
  projectPath: string
  /** Override ASP_HOME location */
  aspHome?: string | undefined
  /** Whether to use locked versions if available (default: true) */
  useLock?: boolean | undefined
  /** Registry git repository path (default: from ASP_HOME) */
  registryPath?: string | undefined
}

/**
 * Result of resolving a target.
 */
export interface ResolveResult {
  /** The target definition from the manifest */
  target: TargetDefinition
  /** The resolved closure */
  closure: ClosureResult
  /** Generated lock file for this target */
  lock: LockFile
  /** Whether this used an existing lock file */
  fromLock: boolean
}

/**
 * Get the registry path for resolution.
 */
export function getRegistryPath(options: ResolveOptions): string {
  if (options.registryPath) {
    return options.registryPath
  }
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  return paths.repo
}

/**
 * Load project manifest from a directory.
 */
export async function loadProjectManifest(projectPath: string): Promise<ProjectManifest> {
  return readTargetsToml(projectPath)
}

/**
 * Load lock file if it exists.
 */
export async function loadLockFileIfExists(projectPath: string): Promise<LockFile | null> {
  if (await lockFileExists(projectPath)) {
    return readLockJson(projectPath)
  }
  return null
}

/**
 * Resolve a target by name.
 *
 * This performs the full resolution process:
 * 1. Load project manifest
 * 2. Load lock file if available and useLock is true
 * 3. Resolve all space references to commits
 * 4. Compute dependency closure
 * 5. Generate lock entries
 */
export async function resolveTarget(
  targetName: string,
  options: ResolveOptions
): Promise<ResolveResult> {
  // Load project manifest
  const manifest = await loadProjectManifest(options.projectPath)

  // Get target definition
  const target = getTarget(manifest, targetName)
  if (!target) {
    throw new Error(`Target not found: ${targetName}`)
  }

  // Check for existing lock
  const useLock = options.useLock !== false
  const existingLock = useLock ? await loadLockFileIfExists(options.projectPath) : null

  // Get registry path
  const registryPath = getRegistryPath(options)

  // Build closure options
  const closureOptions: ClosureOptions = {
    cwd: registryPath,
  }

  // Compute closure from compose list
  const closure = await computeClosure(target.compose, closureOptions)

  // Generate lock file
  const lockOptions: LockGeneratorOptions = {
    cwd: registryPath,
    registry: {
      type: 'git',
      url: registryPath,
    },
  }

  const lock = await generateLockFileForTarget(targetName, target.compose, closure, lockOptions)

  return {
    target,
    closure,
    lock,
    fromLock: existingLock !== null,
  }
}

/**
 * Resolve multiple targets.
 */
export async function resolveTargets(
  targetNames: string[],
  options: ResolveOptions
): Promise<Map<string, ResolveResult>> {
  const results = new Map<string, ResolveResult>()

  for (const name of targetNames) {
    const result = await resolveTarget(name, options)
    results.set(name, result)
  }

  return results
}

/**
 * Get all spaces from a resolve result in load order.
 */
export function getSpacesInOrder(result: ResolveResult): ResolvedSpace[] {
  return result.closure.loadOrder.map((key) => {
    const space = result.closure.spaces.get(key)
    if (!space) {
      throw new Error(`Space not found in closure: ${key}`)
    }
    return space
  })
}
