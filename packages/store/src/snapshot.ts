/**
 * Space snapshot extraction and storage.
 *
 * WHY: Snapshots provide immutable, content-addressed copies of spaces.
 * They enable reproducible builds and efficient caching.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommitSha, Sha256Integrity, SpaceId } from '@agent-spaces/core'
import { SnapshotError, asSha256Integrity } from '@agent-spaces/core'
import { extractTree } from '@agent-spaces/git'
import { computeIntegrity } from '@agent-spaces/resolver'
import { type PathResolver, ensureDir } from './paths.js'

/**
 * Metadata stored with each snapshot.
 */
export interface SnapshotMetadata {
  /** Space identifier */
  spaceId: SpaceId
  /** Source commit SHA */
  commit: CommitSha
  /** Content integrity hash */
  integrity: Sha256Integrity
  /** When the snapshot was created */
  createdAt: string
  /** Path in source repo */
  sourcePath: string
}

/**
 * Options for snapshot operations.
 */
export interface SnapshotOptions {
  /** Path resolver for storage locations */
  paths: PathResolver
  /** Working directory (registry repo root) */
  cwd: string
}

/**
 * Check if a snapshot exists in the store.
 */
export async function snapshotExists(
  integrity: Sha256Integrity,
  options: SnapshotOptions
): Promise<boolean> {
  const snapshotPath = options.paths.snapshot(integrity)
  try {
    const stats = await stat(snapshotPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Get snapshot metadata if it exists.
 */
export async function getSnapshotMetadata(
  integrity: Sha256Integrity,
  options: SnapshotOptions
): Promise<SnapshotMetadata | null> {
  const snapshotPath = options.paths.snapshot(integrity)
  const metaPath = join(snapshotPath, '.asp-snapshot.json')

  try {
    const content = await readFile(metaPath, 'utf-8')
    return JSON.parse(content) as SnapshotMetadata
  } catch {
    return null
  }
}

/**
 * Extract a space from git and store it in the content-addressed store.
 * Returns the integrity hash.
 *
 * If the snapshot already exists, returns immediately without re-extracting.
 */
export async function createSnapshot(
  spaceId: SpaceId,
  commit: CommitSha,
  options: SnapshotOptions
): Promise<Sha256Integrity> {
  // Compute integrity hash first
  const integrity = await computeIntegrity(spaceId, commit, { cwd: options.cwd })

  // Check if already exists
  if (await snapshotExists(integrity, options)) {
    return integrity
  }

  // Ensure store directory exists
  await ensureDir(options.paths.store)
  await ensureDir(options.paths.temp)

  // Extract to temp directory first
  const tempDir = join(options.paths.temp, `snapshot-${Date.now()}`)
  const sourcePath = `spaces/${spaceId}`

  try {
    // Extract the space directory from git
    await extractTree(commit, sourcePath, tempDir, { cwd: options.cwd })

    // Write metadata
    const metadata: SnapshotMetadata = {
      spaceId,
      commit,
      integrity,
      createdAt: new Date().toISOString(),
      sourcePath,
    }
    await writeFile(join(tempDir, '.asp-snapshot.json'), JSON.stringify(metadata, null, 2))

    // Atomically move to final location
    const finalPath = options.paths.snapshot(integrity)
    await rename(tempDir, finalPath)

    return integrity
  } catch (err) {
    // Clean up temp directory on failure
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
    throw new SnapshotError(err instanceof Error ? err.message : String(err), spaceId, commit)
  }
}

/**
 * Verify a snapshot's integrity matches its stored hash.
 */
export async function verifySnapshot(
  integrity: Sha256Integrity,
  options: SnapshotOptions
): Promise<boolean> {
  const snapshotPath = options.paths.snapshot(integrity)

  try {
    // Recompute hash from stored files
    const computedHash = await computeSnapshotIntegrity(snapshotPath)
    return computedHash === integrity
  } catch {
    return false
  }
}

/**
 * Compute integrity hash for a snapshot directory.
 * Uses file walk since this is a local filesystem operation.
 *
 * IMPORTANT: This must match the algorithm in resolver/integrity.ts which uses
 * git tree entries. To be compatible, we compute git-style blob OIDs:
 * - For each file: SHA-1("blob <size>\0<content>") - matches git's blob format
 * - The overall integrity hash is SHA-256 of the canonical representation
 */
async function computeSnapshotIntegrity(snapshotPath: string): Promise<Sha256Integrity> {
  const entries = await collectFileEntries(snapshotPath, '')

  // Filter out metadata file
  const filtered = entries.filter((e) => e.path !== '.asp-snapshot.json')

  // Sort by path
  filtered.sort((a, b) => a.path.localeCompare(b.path))

  // Build canonical representation
  const hash = createHash('sha256')
  hash.update('v1\0')

  for (const entry of filtered) {
    // path\0type\0blobOid\0mode\n (blobOid is git-style SHA-1)
    hash.update(`${entry.path}\0${entry.type}\0${entry.blobOid}\0${entry.mode}\n`)
  }

  return asSha256Integrity(`sha256:${hash.digest('hex')}`)
}

interface FileEntry {
  path: string
  type: 'blob' | 'tree'
  /** Git-style blob OID: SHA-1("blob <size>\0<content>") */
  blobOid: string
  mode: string
}

/**
 * Compute git-style blob OID for file content.
 * Git stores blobs as: SHA-1("blob <size>\0<content>")
 */
function computeGitBlobOid(content: Buffer): string {
  const header = `blob ${content.length}\0`
  return createHash('sha1').update(header).update(content).digest('hex')
}

async function collectFileEntries(basePath: string, relativePath: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = []
  const fullPath = relativePath ? join(basePath, relativePath) : basePath

  const items = await readdir(fullPath, { withFileTypes: true })

  for (const item of items) {
    const itemRelPath = relativePath ? join(relativePath, item.name) : item.name

    if (item.isDirectory()) {
      // Recursively collect from subdirectory
      const subEntries = await collectFileEntries(basePath, itemRelPath)
      entries.push(...subEntries)
    } else if (item.isFile()) {
      const itemFullPath = join(basePath, itemRelPath)
      const content = await readFile(itemFullPath)
      // Use git-style blob OID to match resolver/integrity.ts
      const blobOid = computeGitBlobOid(content)
      const stats = await stat(itemFullPath)
      const mode = stats.mode & 0o111 ? '100755' : '100644'

      entries.push({
        path: itemRelPath,
        type: 'blob',
        blobOid,
        mode,
      })
    }
  }

  return entries
}

/**
 * Delete a snapshot from the store.
 */
export async function deleteSnapshot(
  integrity: Sha256Integrity,
  options: SnapshotOptions
): Promise<void> {
  const snapshotPath = options.paths.snapshot(integrity)
  await rm(snapshotPath, { recursive: true, force: true })
}

/**
 * List all snapshots in the store.
 */
export async function listSnapshots(options: SnapshotOptions): Promise<Sha256Integrity[]> {
  try {
    const items = await readdir(options.paths.store, { withFileTypes: true })
    const integrities: Sha256Integrity[] = []

    for (const item of items) {
      if (item.isDirectory() && /^[0-9a-f]{64}$/.test(item.name)) {
        integrities.push(asSha256Integrity(`sha256:${item.name}`))
      }
    }

    return integrities
  } catch {
    return []
  }
}

/**
 * Get the size of a snapshot in bytes.
 */
export async function getSnapshotSize(
  integrity: Sha256Integrity,
  options: SnapshotOptions
): Promise<number> {
  const snapshotPath = options.paths.snapshot(integrity)
  return computeDirSize(snapshotPath)
}

async function computeDirSize(dirPath: string): Promise<number> {
  let size = 0
  const items = await readdir(dirPath, { withFileTypes: true })

  for (const item of items) {
    const itemPath = join(dirPath, item.name)
    if (item.isDirectory()) {
      size += await computeDirSize(itemPath)
    } else {
      const stats = await stat(itemPath)
      size += stats.size
    }
  }

  return size
}
