/**
 * Atomic file write utilities for Agent Spaces v2
 *
 * Provides crash-safe file writes by writing to a temporary file
 * and then atomically renaming to the target path.
 */

import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** Options for atomic write operations */
export interface AtomicWriteOptions {
  /** File mode (default: 0o644) */
  mode?: number
  /** Temporary file suffix (default: .tmp) */
  tmpSuffix?: string
  /** Whether to fsync before rename (default: true for durability) */
  fsync?: boolean
}

const DEFAULT_OPTIONS: Required<AtomicWriteOptions> = {
  mode: 0o644,
  tmpSuffix: '.tmp',
  fsync: true,
}

/**
 * Generate a unique temporary file path
 */
function getTmpPath(targetPath: string, suffix: string): string {
  const dir = path.dirname(targetPath)
  const base = path.basename(targetPath)
  const rand = crypto.randomBytes(6).toString('hex')
  return path.join(dir, `.${base}.${rand}${suffix}`)
}

/**
 * Write content to a file atomically
 *
 * Writes to a temporary file first, then renames to the target path.
 * This ensures the target file is never in a partial/corrupted state.
 *
 * @param filePath - Target file path
 * @param content - Content to write (string or Buffer)
 * @param options - Write options
 */
export async function atomicWrite(
  filePath: string,
  content: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const opts = { ...DEFAULT_OPTIONS, ...options }

  // Ensure parent directory exists
  const dir = path.dirname(filePath)
  await fs.promises.mkdir(dir, { recursive: true })

  // Generate temp path
  const tmpPath = getTmpPath(filePath, opts.tmpSuffix)

  try {
    // Write to temp file
    await fs.promises.writeFile(tmpPath, content, { mode: opts.mode })

    // Flush to disk if requested (open and sync)
    if (opts.fsync) {
      const fd = await fs.promises.open(tmpPath, 'r')
      try {
        await fd.sync()
      } finally {
        await fd.close()
      }
    }

    // Atomically rename temp to target
    await fs.promises.rename(tmpPath, filePath)
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.promises.unlink(tmpPath)
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }
}

/**
 * Write JSON content to a file atomically (pretty-printed)
 *
 * @param filePath - Target file path
 * @param data - Data to serialize as JSON
 * @param options - Write options
 */
export async function atomicWriteJson(
  filePath: string,
  data: unknown,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const content = `${JSON.stringify(data, null, 2)}\n`
  await atomicWrite(filePath, content, options)
}

// ============================================================================
// Atomic directory operations
// ============================================================================

/**
 * Atomically create a directory by creating in temp location and renaming
 *
 * @param targetDir - Target directory path
 * @param createFn - Function to populate the directory
 */
export async function atomicDir<T>(
  targetDir: string,
  createFn: (tmpDir: string) => Promise<T>
): Promise<T> {
  const parent = path.dirname(targetDir)
  const base = path.basename(targetDir)
  const rand = crypto.randomBytes(6).toString('hex')
  const tmpDir = path.join(parent, `.${base}.${rand}.tmp`)

  // Ensure parent exists
  await fs.promises.mkdir(parent, { recursive: true })

  // Create temp directory
  await fs.promises.mkdir(tmpDir, { recursive: true })

  try {
    // Populate the directory
    const result = await createFn(tmpDir)

    // Remove target if it exists (for overwrite)
    try {
      await fs.promises.rm(targetDir, { recursive: true })
    } catch {
      // Target doesn't exist, that's fine
    }

    // Atomically rename temp to target
    await fs.promises.rename(tmpDir, targetDir)

    return result
  } catch (err) {
    // Clean up temp directory on error
    try {
      await fs.promises.rm(tmpDir, { recursive: true })
    } catch {
      // Ignore cleanup errors
    }
    throw err
  }
}

// ============================================================================
// File copy utilities
// ============================================================================

/**
 * Copy a file, preserving mode and creating parent directories
 *
 * @param src - Source file path
 * @param dest - Destination file path
 * @param options - Optional overrides
 */
export async function copyFile(
  src: string,
  dest: string,
  options: { mode?: number } = {}
): Promise<void> {
  // Ensure parent directory exists
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })

  // Copy the file
  await fs.promises.copyFile(src, dest)

  // Set mode if specified, otherwise preserve source mode
  if (options.mode !== undefined) {
    await fs.promises.chmod(dest, options.mode)
  } else {
    const srcStat = await fs.promises.stat(src)
    await fs.promises.chmod(dest, srcStat.mode)
  }
}

/**
 * Try to hardlink a file, falling back to copy if hardlink fails
 *
 * Hardlinks are faster and more disk-efficient when possible.
 *
 * @param src - Source file path
 * @param dest - Destination file path
 * @returns 'hardlink' if hardlinked, 'copy' if copied
 */
export async function linkOrCopy(src: string, dest: string): Promise<'hardlink' | 'copy'> {
  // Ensure parent directory exists
  await fs.promises.mkdir(path.dirname(dest), { recursive: true })

  try {
    // Try hardlink first
    await fs.promises.link(src, dest)
    return 'hardlink'
  } catch (err) {
    // Hardlink failed (cross-device, permissions, etc.)
    // Fall back to copy
    if (
      err instanceof Error &&
      (err as NodeJS.ErrnoException).code &&
      ['EXDEV', 'EPERM', 'ENOTSUP'].includes((err as NodeJS.ErrnoException).code ?? '')
    ) {
      await copyFile(src, dest)
      return 'copy'
    }
    throw err
  }
}

/**
 * Recursively copy a directory
 *
 * @param src - Source directory path
 * @param dest - Destination directory path
 * @param options - Copy options
 */
export async function copyDir(
  src: string,
  dest: string,
  options: { useHardlinks?: boolean } = {}
): Promise<void> {
  await fs.promises.mkdir(dest, { recursive: true })

  const entries = await fs.promises.readdir(src, { withFileTypes: true })

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath, options)
    } else if (entry.isFile()) {
      if (options.useHardlinks) {
        await linkOrCopy(srcPath, destPath)
      } else {
        await copyFile(srcPath, destPath)
      }
    } else if (entry.isSymbolicLink()) {
      const target = await fs.promises.readlink(srcPath)
      await fs.promises.symlink(target, destPath)
    }
  }
}
