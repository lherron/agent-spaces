/**
 * Lock file types for Agent Spaces v2
 *
 * The lock file (asp-lock.json) pins Space versions to concrete
 * commits and stores integrity hashes for reproducibility.
 */

import type { CompileContext } from 'spaces-runtime-contracts'
import { resolveNowIso } from '../compile-clock.js'
import type { CommitSha, Sha256Integrity, SpaceId, SpaceKey, SpaceRefString } from './refs.js'

interface LockRegistryBase {
  /** Registry type (currently only "git") */
  type: 'git'
  /** Default branch name */
  defaultBranch?: string
}

/** Legacy path-bearing registry information, accepted only for regeneration. */
export interface LegacyLockRegistry extends LockRegistryBase {
  /**
   * Legacy checkout locator. Accepted only so an old lock can be regenerated;
   * newly generated portable locks never emit this node-local field.
   */
  url: string
  repository?: never
  canonicalRemote?: never
}

/** Portable canonical identity for immutable registry content. */
export interface PortableLockRegistry extends LockRegistryBase {
  /** Stable repository identity used by portable locks. */
  repository: string
  /** Canonical source remote for immutable commits. */
  canonicalRemote: string
  url?: never
}

/** Registry information in a lock file. */
export type LockRegistry = LegacyLockRegistry | PortableLockRegistry

/** Canonical immutable source identity emitted by newly generated ASP locks. */
export const PORTABLE_SPACES_REGISTRY: PortableLockRegistry = Object.freeze({
  type: 'git',
  repository: 'spaces-repo',
  canonicalRemote: 'git@github.com:lherron/spaces-repo.git',
  defaultBranch: 'main',
})

/** Plugin identity stored in lock */
export interface LockPluginInfo {
  /** Plugin name (from space.toml) */
  name: string
  /** Plugin version (from space.toml) */
  version?: string
}

/** Dependencies stored in lock */
export interface LockSpaceDeps {
  /** Resolved space keys for dependencies */
  spaces: SpaceKey[]
}

/** Resolution provenance information */
export interface ResolvedFrom {
  /** Original selector string */
  selector?: string
  /** Git tag that was resolved */
  tag?: string
  /** Semver version that was matched */
  semver?: string
}

/** A resolved space entry in the lock file */
export interface LockSpaceEntry {
  /** Space identifier */
  id: SpaceId
  /** Resolved commit SHA (or "project" for project-local spaces) */
  commit: CommitSha
  /** Path in registry repo (e.g., "spaces/todo-frontend") or project (for project spaces) */
  path: string
  /** Content integrity hash */
  integrity: Sha256Integrity
  /** Plugin identity */
  plugin: LockPluginInfo
  /** Resolved dependencies */
  deps: LockSpaceDeps
  /** How this version was resolved */
  resolvedFrom?: ResolvedFrom
  /** True if this is a project-local space (space:project:<id>) */
  projectSpace?: boolean
  /** True if this is an agent-local space (space:agent:<id>) */
  agentSpace?: boolean
}

/** Warning recorded during resolution */
export interface LockWarning {
  /** Warning code (e.g., "W201") */
  code: string
  /** Human-readable message */
  message: string
  /** Additional details */
  details?: Record<string, unknown>
}

/** Harness-specific entry in lock file (Phase 2: Two-Phase Materialization) */
export interface LockHarnessEntry {
  /** Environment hash for this harness (includes harness ID + version) */
  envHash: Sha256Integrity
  /** Harness-specific warnings (e.g., W301: blocking hook not supported) */
  warnings?: LockWarning[]
}

/** A resolved target entry in the lock file */
export interface LockTargetEntry {
  /** Original compose list from manifest */
  compose: SpaceRefString[]
  /** Resolved root space keys (one per compose entry) */
  roots: SpaceKey[]
  /** Deterministic load order (deps before dependents) */
  loadOrder: SpaceKey[]
  /** Environment hash for this target */
  envHash: Sha256Integrity
  /** Warnings generated during resolution */
  warnings?: LockWarning[]
  /** Per-harness entries with harness-specific envHash and warnings (Phase 2) */
  harnesses?: Record<string, LockHarnessEntry>
}

/**
 * Lock file (asp-lock.json)
 *
 * The lock is the reproducibility anchor. It pins Space selection
 * to concrete commits and content integrity.
 */
export interface LockFile {
  /** Lock file format version */
  lockfileVersion: 1
  /** Resolver algorithm version */
  resolverVersion: 1
  /** When this lock was generated */
  generatedAt: string
  /** Registry information */
  registry: LockRegistry
  /** Content-addressed space entries keyed by spaceKey */
  spaces: Record<SpaceKey, LockSpaceEntry>
  /** Per-target resolution results */
  targets: Record<string, LockTargetEntry>
}

// ============================================================================
// Helper functions
// ============================================================================

/** Create an empty lock file structure */
export function createEmptyLockFile(
  registry: LockRegistry,
  compileContext?: CompileContext | undefined
): LockFile {
  return {
    lockfileVersion: 1,
    resolverVersion: 1,
    generatedAt: resolveNowIso(compileContext),
    registry,
    spaces: {},
    targets: {},
  }
}

/** Get all unique space keys from a lock file */
export function getAllSpaceKeys(lock: LockFile): SpaceKey[] {
  return Object.keys(lock.spaces) as SpaceKey[]
}

/** Get space entry by key */
export function getSpaceEntry(lock: LockFile, key: SpaceKey): LockSpaceEntry | undefined {
  return lock.spaces[key]
}

/** Get target entry by name */
export function getTargetEntry(lock: LockFile, name: string): LockTargetEntry | undefined {
  return lock.targets[name]
}

/** Check if a lock file has a specific target */
export function hasTarget(lock: LockFile, name: string): boolean {
  return name in lock.targets
}

/** Get all target names from a lock file */
export function getTargetNames(lock: LockFile): string[] {
  return Object.keys(lock.targets)
}

/** Get the load order for a target as space entries */
export function getLoadOrderEntries(lock: LockFile, targetName: string): LockSpaceEntry[] {
  const target = lock.targets[targetName]
  if (!target) {
    const available = getTargetNames(lock)
    const availableStr =
      available.length > 0
        ? `Available targets in lock: ${available.join(', ')}`
        : 'No targets in lock file'
    throw new Error(`Target "${targetName}" not found in lock file. ${availableStr}`)
  }

  return target.loadOrder.map((key) => {
    const entry = lock.spaces[key]
    if (!entry) {
      throw new Error(`Space entry "${key}" not found in lock file for target "${targetName}"`)
    }
    return entry
  })
}
