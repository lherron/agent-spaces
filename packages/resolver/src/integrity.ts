/**
 * Integrity hashing for spaces.
 *
 * WHY: Integrity hashes verify space snapshots are not corrupted.
 * They use a deterministic algorithm based on git tree contents.
 * For @dev refs, we use a placeholder since filesystem state is mutable.
 */

import { createHash } from 'node:crypto'
import type { CommitSha, Sha256Integrity, SpaceId } from 'spaces-core'
import { asSha256Integrity } from 'spaces-core'
import { type TreeEntry, filterTreeEntries, listTreeRecursive } from 'spaces-git'

import { DEV_COMMIT_MARKER } from './closure.js'

/** Placeholder integrity for @dev refs (filesystem is mutable, uses special marker) */
export const DEV_INTEGRITY = 'sha256:dev' as Sha256Integrity

/**
 * Options for integrity hashing.
 */
export interface IntegrityOptions {
  /** Working directory (registry repo root) */
  cwd: string
}

/**
 * Compute the integrity hash for a space at a specific commit.
 *
 * Algorithm:
 * 1. List all files under spaces/<id>/ at the commit
 * 2. Filter out ignored paths (node_modules, .git, etc.)
 * 3. Sort entries by path (lexicographic)
 * 4. Build canonical representation:
 *    "v1\0" + for each entry: path + "\0" + type + "\0" + oid + "\0" + mode + "\n"
 * 5. SHA256 the result
 */
export async function computeIntegrity(
  spaceId: SpaceId,
  commit: CommitSha,
  options: IntegrityOptions
): Promise<Sha256Integrity> {
  // @dev refs use a placeholder - filesystem is mutable
  if (commit === DEV_COMMIT_MARKER) {
    return DEV_INTEGRITY
  }

  const treePath = `spaces/${spaceId}`
  const ref = commit

  // Get all files recursively
  let entries: TreeEntry[]
  try {
    entries = await listTreeRecursive(ref, treePath, { cwd: options.cwd })
  } catch (_err) {
    // If the tree doesn't exist, return a hash of empty content
    const hash = createHash('sha256')
    hash.update('v1\0')
    return asSha256Integrity(`sha256:${hash.digest('hex')}`)
  }

  // Filter out ignored paths
  const filtered = filterTreeEntries(entries)

  // Sort by path (lexicographic)
  filtered.sort((a, b) => a.path.localeCompare(b.path))

  // Build canonical representation
  const hash = createHash('sha256')
  hash.update('v1\0')

  for (const entry of filtered) {
    // path\0type\0oid\0mode\n
    hash.update(`${entry.path}\0${entry.type}\0${entry.oid}\0${entry.mode}\n`)
  }

  const digest = hash.digest('hex')
  return asSha256Integrity(`sha256:${digest}`)
}

/**
 * Compute the environment hash from load order and integrities.
 *
 * Formula:
 * sha256("env-v1\0" + for each spaceKey in loadOrder:
 *   spaceKey + "\0" + integrity + "\0" + pluginName + "\n")
 */
export function computeEnvHash(
  loadOrder: Array<{
    spaceKey: string
    integrity: Sha256Integrity
    pluginName: string
  }>
): Sha256Integrity {
  const hash = createHash('sha256')
  hash.update('env-v1\0')

  for (const entry of loadOrder) {
    hash.update(`${entry.spaceKey}\0${entry.integrity}\0${entry.pluginName}\n`)
  }

  const digest = hash.digest('hex')
  return asSha256Integrity(`sha256:${digest}`)
}

/**
 * Compute a harness-specific environment hash.
 *
 * This extends the base envHash with a harness identifier prefix,
 * allowing different harnesses to have distinct cache keys for the same
 * resolved environment.
 *
 * Formula:
 * sha256("env-harness-v1\0" + harnessId + "\0" + for each spaceKey in loadOrder:
 *   spaceKey + "\0" + integrity + "\0" + pluginName + "\n")
 *
 * Note: Harness version is intentionally excluded because:
 * 1. Version changes independently of space content
 * 2. The actual materialization cache uses computeHarnessPluginCacheKey which includes version
 * 3. This hash is for "resolved environment identity" not "materialized artifact identity"
 */
export function computeHarnessEnvHash(
  harnessId: string,
  loadOrder: Array<{
    spaceKey: string
    integrity: Sha256Integrity
    pluginName: string
  }>
): Sha256Integrity {
  const hash = createHash('sha256')
  hash.update(`env-harness-v1\0${harnessId}\0`)

  for (const entry of loadOrder) {
    hash.update(`${entry.spaceKey}\0${entry.integrity}\0${entry.pluginName}\n`)
  }

  const digest = hash.digest('hex')
  return asSha256Integrity(`sha256:${digest}`)
}

/**
 * Verify an integrity hash matches the computed value.
 */
export async function verifyIntegrity(
  spaceId: SpaceId,
  commit: CommitSha,
  expected: Sha256Integrity,
  options: IntegrityOptions
): Promise<boolean> {
  const computed = await computeIntegrity(spaceId, commit, options)
  return computed === expected
}
