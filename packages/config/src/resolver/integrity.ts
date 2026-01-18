/**
 * Integrity hashing for spaces.
 *
 * WHY: Integrity hashes verify space snapshots are not corrupted.
 * They use a deterministic algorithm based on git tree contents.
 * For @dev refs, we use a placeholder since filesystem state is mutable.
 * For project spaces, we compute real hashes from the filesystem.
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommitSha, Sha256Integrity, SpaceId } from '../core/index.js'
import { PROJECT_COMMIT_MARKER, asSha256Integrity } from '../core/index.js'
import { type TreeEntry, filterTreeEntries, listTreeRecursive } from '../git/index.js'

import { DEV_COMMIT_MARKER } from './closure.js'

/** Placeholder integrity for @dev refs (filesystem is mutable, uses special marker) */
export const DEV_INTEGRITY = 'sha256:dev' as Sha256Integrity

/**
 * Options for integrity hashing.
 */
export interface IntegrityOptions {
  /** Working directory (registry repo root) */
  cwd: string
  /** Project root for project-local spaces */
  projectRoot?: string | undefined
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

  // Project spaces compute integrity from filesystem
  if (commit === PROJECT_COMMIT_MARKER) {
    if (!options.projectRoot) {
      throw new Error(`Project root is required to compute integrity for project space: ${spaceId}`)
    }
    const spacePath = join(options.projectRoot, 'spaces', spaceId)
    return computeFilesystemIntegrity(spacePath)
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

/** Paths to ignore when computing filesystem integrity */
const IGNORED_PATHS = new Set(['node_modules', '.git', '.DS_Store', 'Thumbs.db'])

/** File extensions to ignore */
const IGNORED_EXTENSIONS = new Set(['.pyc', '.pyo', '.class'])

/**
 * Check if a path should be ignored for integrity computation.
 */
function shouldIgnorePath(path: string): boolean {
  const parts = path.split('/')
  for (const part of parts) {
    if (IGNORED_PATHS.has(part)) {
      return true
    }
  }
  for (const ext of IGNORED_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return true
    }
  }
  return false
}

/**
 * Compute git-style blob OID for file content.
 * Git stores blobs as: SHA-1("blob <size>\0<content>")
 */
function computeGitBlobOid(content: Buffer): string {
  const header = `blob ${content.length}\0`
  return createHash('sha1').update(header).update(content).digest('hex')
}

interface FilesystemEntry {
  path: string
  type: 'blob'
  oid: string
  mode: string
}

/**
 * Recursively collect file entries from filesystem.
 */
async function collectFilesystemEntries(
  basePath: string,
  relativePath: string
): Promise<FilesystemEntry[]> {
  const entries: FilesystemEntry[] = []
  const fullPath = relativePath ? join(basePath, relativePath) : basePath

  let items: Dirent[]
  try {
    items = await readdir(fullPath, { withFileTypes: true })
  } catch {
    return entries
  }

  for (const item of items) {
    const itemName = String(item.name)
    const itemRelPath = relativePath ? join(relativePath, itemName) : itemName

    // Skip ignored paths
    if (shouldIgnorePath(itemRelPath)) {
      continue
    }

    if (item.isDirectory()) {
      const subEntries = await collectFilesystemEntries(basePath, itemRelPath)
      entries.push(...subEntries)
    } else if (item.isFile()) {
      const itemFullPath = join(basePath, itemRelPath)
      const content = await readFile(itemFullPath)
      const oid = computeGitBlobOid(content)
      const stats = await stat(itemFullPath)
      const mode = stats.mode & 0o111 ? '100755' : '100644'

      entries.push({
        path: itemRelPath,
        type: 'blob',
        oid,
        mode,
      })
    }
  }

  return entries
}

/**
 * Compute integrity hash from filesystem directory.
 * Uses the same algorithm as git-based integrity for compatibility.
 */
export async function computeFilesystemIntegrity(spacePath: string): Promise<Sha256Integrity> {
  const entries = await collectFilesystemEntries(spacePath, '')

  // Sort by path (lexicographic)
  entries.sort((a, b) => a.path.localeCompare(b.path))

  // Build canonical representation (same as git-based)
  const hash = createHash('sha256')
  hash.update('v1\0')

  for (const entry of entries) {
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
