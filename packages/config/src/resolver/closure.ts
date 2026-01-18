/**
 * Dependency closure computation via DFS postorder.
 *
 * WHY: Spaces can depend on other spaces. We need to compute
 * the full transitive closure and determine load order such
 * that dependencies are loaded before dependents.
 */

import type {
  CommitSha,
  SpaceId,
  SpaceKey,
  SpaceManifest,
  SpaceRef,
  SpaceRefString,
} from '../core/index.js'
import {
  CyclicDependencyError,
  MissingDependencyError,
  PROJECT_COMMIT_MARKER,
  asSpaceKey,
} from '../core/index.js'
import {
  type ManifestReadOptions,
  getSpaceDependencies,
  readSpaceManifest,
  readSpaceManifestFromFilesystem,
} from './manifest.js'
import { buildSpaceKey, parseSpaceRef } from './ref-parser.js'
import { type ResolvedSelector, type SelectorResolveOptions, resolveSelector } from './selector.js'

/** Marker commit for @dev refs (not a real git SHA) */
export const DEV_COMMIT_MARKER = 'dev' as CommitSha

/**
 * A resolved space in the dependency graph.
 */
export interface ResolvedSpace {
  /** Unique key: <id>@<commit-prefix> */
  key: SpaceKey
  /** Space identifier */
  id: SpaceId
  /** Resolved commit SHA */
  commit: CommitSha
  /** Path in registry (or project for project spaces) */
  path: string
  /** The space manifest */
  manifest: SpaceManifest
  /** Resolution provenance */
  resolvedFrom: ResolvedSelector
  /** Direct dependency keys */
  deps: SpaceKey[]
  /** True if this is a project-local space */
  projectSpace?: boolean | undefined
}

/**
 * Result of closure computation.
 */
export interface ClosureResult {
  /** All resolved spaces keyed by SpaceKey */
  spaces: Map<SpaceKey, ResolvedSpace>
  /** Load order (dependencies first) */
  loadOrder: SpaceKey[]
  /** Root space keys (from compose) */
  roots: SpaceKey[]
}

/**
 * Options for closure computation.
 */
export interface ClosureOptions extends SelectorResolveOptions, ManifestReadOptions {
  /**
   * Pinned spaces to use instead of resolving.
   * Map from SpaceId to CommitSha. When a space is in this map,
   * use the pinned commit instead of resolving the selector.
   * Used for selective upgrades (upgrading specific spaces while
   * keeping others at their locked versions).
   */
  pinnedSpaces?: Map<SpaceId, CommitSha> | undefined
  /**
   * Project root directory (contains asp-targets.toml).
   * Required for resolving project-local spaces (space:project:<id>).
   */
  projectRoot?: string | undefined
}

/**
 * Compute the dependency closure for a set of root space refs.
 */
export async function computeClosure(
  rootRefs: SpaceRefString[],
  options: ClosureOptions
): Promise<ClosureResult> {
  const spaces = new Map<SpaceKey, ResolvedSpace>()
  const loadOrder: SpaceKey[] = []
  const roots: SpaceKey[] = []

  // Track visiting state for cycle detection
  // - not in map: not visited
  // - visiting: in current DFS path (potential cycle)
  // - visited: fully processed
  const visitState = new Map<SpaceKey, 'visiting' | 'visited'>()

  // DFS stack for cycle path reporting
  const visitPath: SpaceKey[] = []

  async function visit(ref: SpaceRef): Promise<SpaceKey> {
    // Handle @dev selector specially - uses filesystem instead of git
    const isDev = ref.selector.kind === 'dev'
    // Handle project-local spaces (space:project:<id>)
    const isProjectSpace = ref.projectSpace === true

    // Check if this space is pinned (for selective upgrades)
    const pinnedCommit = options.pinnedSpaces?.get(ref.id)

    // Resolve the ref to a commit (or use pinned commit, or use dev/project marker)
    let resolved: ResolvedSelector
    let key: SpaceKey

    if (isProjectSpace) {
      // Project space uses a special marker and reads from project root
      if (!options.projectRoot) {
        throw new Error(
          `Project root is required to resolve project space: space:project:${ref.id}`
        )
      }
      resolved = {
        commit: PROJECT_COMMIT_MARKER,
        selector: { kind: 'dev' },
      }
      // Build key as "id@project" instead of "id@<commit-prefix>"
      key = asSpaceKey(ref.id, PROJECT_COMMIT_MARKER)
    } else if (isDev) {
      // @dev uses a special marker and reads from filesystem
      resolved = {
        commit: DEV_COMMIT_MARKER,
        selector: { kind: 'dev' },
      }
      // Build key as "id@dev" instead of "id@<commit-prefix>"
      key = asSpaceKey(ref.id, DEV_COMMIT_MARKER)
    } else if (pinnedCommit !== undefined) {
      // Use the pinned commit with a git-pin selector
      resolved = {
        commit: pinnedCommit,
        selector: { kind: 'git-pin', sha: pinnedCommit },
      }
      key = buildSpaceKey(ref.id, resolved.commit)
    } else {
      resolved = await resolveSelector(ref.id, ref.selector, options)
      key = buildSpaceKey(ref.id, resolved.commit)
    }

    // Check visit state
    const state = visitState.get(key)
    if (state === 'visited') {
      // Already fully processed
      return key
    }
    if (state === 'visiting') {
      // Cycle detected!
      const cycleStart = visitPath.indexOf(key)
      const cyclePath = [...visitPath.slice(cycleStart), key]
      throw new CyclicDependencyError(cyclePath)
    }

    // Mark as visiting
    visitState.set(key, 'visiting')
    visitPath.push(key)

    // Read the manifest based on space type:
    // - Project spaces: read from <projectRoot>/spaces/<id>/
    // - @dev refs: read from registry filesystem (cwd)
    // - Others: read from git at specific commit
    let manifest: SpaceManifest
    if (isProjectSpace) {
      // Project space: read from project root
      const projectSpacePath = `${options.projectRoot}/spaces/${ref.id}`
      manifest = await readSpaceManifestFromFilesystem(projectSpacePath, options)
    } else if (isDev) {
      // @dev: read from registry filesystem
      const manifestLocation = ref.path ?? ref.id
      manifest = await readSpaceManifestFromFilesystem(manifestLocation, options)
    } else {
      // Registry space: read from git
      manifest = await readSpaceManifest(ref.id, resolved.commit, options)
    }

    // Get dependencies
    const depRefs = getSpaceDependencies(manifest)
    const depKeys: SpaceKey[] = []

    // Visit dependencies in declared order
    for (const depRefString of depRefs) {
      try {
        const depRef = parseSpaceRef(depRefString)
        const depKey = await visit(depRef)
        depKeys.push(depKey)
      } catch (err) {
        if (err instanceof CyclicDependencyError) {
          throw err
        }
        // Wrap resolution errors as missing dependency
        // MissingDependencyError takes (spaceId, dependsOn)
        throw new MissingDependencyError(ref.id, depRefString)
      }
    }

    // All deps visited, now add this space (postorder)
    // Path depends on space type:
    // - Project spaces: spaces/<id> (relative to project root)
    // - Path refs: use the path from the ref
    // - Registry refs: spaces/<id> (relative to registry)
    const spacePath = ref.path ?? `spaces/${ref.id}`
    const resolvedSpace: ResolvedSpace = {
      key,
      id: ref.id,
      commit: resolved.commit,
      path: spacePath,
      manifest,
      resolvedFrom: resolved,
      deps: depKeys,
      projectSpace: isProjectSpace || undefined,
    }

    spaces.set(key, resolvedSpace)
    loadOrder.push(key)

    // Mark as fully visited
    visitPath.pop()
    visitState.set(key, 'visited')

    return key
  }

  // Process all root refs in declared order
  for (const rootRefString of rootRefs) {
    const rootRef = parseSpaceRef(rootRefString)
    const rootKey = await visit(rootRef)
    roots.push(rootKey)
  }

  return { spaces, loadOrder, roots }
}

/**
 * Get a space from the closure by key.
 */
export function getSpace(closure: ClosureResult, key: SpaceKey): ResolvedSpace | undefined {
  return closure.spaces.get(key)
}

/**
 * Get all spaces in load order.
 */
export function getSpacesInOrder(closure: ClosureResult): ResolvedSpace[] {
  return closure.loadOrder
    .map((key) => closure.spaces.get(key))
    .filter((s): s is ResolvedSpace => s !== undefined)
}

/**
 * Check if a space is a root (directly specified in compose).
 */
export function isRoot(closure: ClosureResult, key: SpaceKey): boolean {
  return closure.roots.includes(key)
}

/**
 * Get the dependents of a space (spaces that depend on it).
 */
export function getDependents(closure: ClosureResult, key: SpaceKey): SpaceKey[] {
  const dependents: SpaceKey[] = []
  for (const [k, space] of closure.spaces) {
    if (space.deps.includes(key)) {
      dependents.push(k)
    }
  }
  return dependents
}
