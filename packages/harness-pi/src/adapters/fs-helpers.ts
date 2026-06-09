/**
 * Filesystem helpers shared by materialize/compose.
 *
 * Collapses the repeated "stat dir -> isDirectory -> copy/readdir" pattern and
 * distinguishes a missing source directory (ENOENT) from real IO failures so
 * the latter are no longer silently swallowed.
 */

import { readdir, stat } from 'node:fs/promises'
import { copyDir } from 'spaces-config'

/** Returns true if the error is a Node "file/dir not found" error. */
export function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

/**
 * Returns true if `path` exists and is a directory. Returns false only when the
 * path is absent (ENOENT); re-throws other IO errors (e.g. EACCES, EMFILE)
 * instead of silently swallowing them as "doesn't exist".
 */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch (err) {
    if (isEnoent(err)) {
      return false
    }
    throw err
  }
}

/**
 * Copy a source component directory into a destination, no-op when the source
 * directory is absent. Re-throws non-ENOENT IO errors instead of swallowing
 * them.
 *
 * @returns `true` if the directory existed and was copied, `false` if absent.
 */
export async function copyComponentDir(srcDir: string, destDir: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof stat>>
  try {
    stats = await stat(srcDir)
  } catch (err) {
    if (isEnoent(err)) {
      return false
    }
    throw err
  }

  if (!stats.isDirectory()) {
    return false
  }

  await copyDir(srcDir, destDir)
  return true
}

/**
 * List the entry names of a directory, returning an empty array when absent.
 * Re-throws non-ENOENT IO errors.
 */
export async function listDirEntries(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch (err) {
    if (isEnoent(err)) {
      return []
    }
    throw err
  }
}
