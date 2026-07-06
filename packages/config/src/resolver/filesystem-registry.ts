/**
 * Filesystem registry helpers used when a registry fixture is checked in as
 * plain files instead of initialized as its own Git repository.
 */

import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { CommitSha, SpaceId } from '../core/index.js'
import { asCommitSha } from '../core/index.js'

async function hasLocalGitMetadata(cwd: string): Promise<boolean> {
  try {
    await lstat(join(cwd, '.git'))
    return true
  } catch {
    return false
  }
}

/**
 * Only use filesystem fallback when the registry root itself is not a Git
 * checkout. This prevents Git from walking upward into an enclosing repo for
 * checked-in fixture registries.
 */
export async function shouldUseFilesystemRegistryFallback(cwd: string): Promise<boolean> {
  return !(await hasLocalGitMetadata(cwd))
}

export async function readRegistryFileFromFilesystemOrNull(
  cwd: string,
  relativePath: string
): Promise<string | null> {
  if (!(await shouldUseFilesystemRegistryFallback(cwd))) {
    return null
  }

  try {
    return await readFile(join(cwd, relativePath), 'utf8')
  } catch {
    return null
  }
}

interface FilesystemEntry {
  path: string
  type: 'blob'
  oid: string
  mode: string
}

function shouldIgnorePath(path: string): boolean {
  return path
    .split('/')
    .some((part) => part === 'node_modules' || part === '.git' || part === '.DS_Store')
}

function computeGitBlobOid(content: Buffer): string {
  const header = `blob ${content.length}\0`
  return createHash('sha1').update(header).update(content).digest('hex')
}

async function collectFilesystemEntries(
  basePath: string,
  relativePath = ''
): Promise<FilesystemEntry[]> {
  const fullPath = relativePath ? join(basePath, relativePath) : basePath
  let items: Dirent[]
  try {
    items = await readdir(fullPath, { withFileTypes: true })
  } catch {
    return []
  }

  const entries: FilesystemEntry[] = []
  for (const item of items) {
    const name = String(item.name)
    const itemRelPath = relativePath ? join(relativePath, name) : name
    if (shouldIgnorePath(itemRelPath)) {
      continue
    }

    if (item.isDirectory()) {
      entries.push(...(await collectFilesystemEntries(basePath, itemRelPath)))
      continue
    }

    if (!item.isFile()) {
      continue
    }

    const itemPath = join(basePath, itemRelPath)
    const content = await readFile(itemPath)
    const stats = await stat(itemPath)
    entries.push({
      path: itemRelPath,
      type: 'blob',
      oid: computeGitBlobOid(content),
      mode: stats.mode & 0o111 ? '100755' : '100644',
    })
  }

  return entries
}

export async function computeFilesystemRegistryCommit(
  spaceId: SpaceId,
  version: string,
  cwd: string
): Promise<CommitSha | null> {
  if (!(await shouldUseFilesystemRegistryFallback(cwd))) {
    return null
  }

  const spacePath = join(cwd, 'spaces', spaceId)
  const entries = await collectFilesystemEntries(spacePath)
  if (entries.length === 0) {
    return null
  }

  entries.sort((a, b) => a.path.localeCompare(b.path))

  const hash = createHash('sha256')
  hash.update(`filesystem-registry-v1\0${spaceId}\0${version}\0`)
  for (const entry of entries) {
    hash.update(`${entry.path}\0${entry.type}\0${entry.oid}\0${entry.mode}\n`)
  }

  return asCommitSha(hash.digest('hex'))
}
