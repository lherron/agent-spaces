/**
 * Cross-platform file locking primitives for Agent Spaces v2
 *
 * Uses proper-lockfile for reliable file locking across platforms.
 * Provides project-level and global store locks to prevent concurrent access.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import lockfile from 'proper-lockfile'

import { LockError, LockTimeoutError } from './errors.js'

/** Lock options */
export interface LockOptions {
  /** Timeout in milliseconds (default: 30000) */
  timeout?: number
  /** Stale lock threshold in milliseconds (default: 10000) */
  stale?: number
  /** Retry interval in milliseconds (default: 100) */
  retries?: number
}

/** Default lock options */
const DEFAULT_LOCK_OPTIONS: Required<LockOptions> = {
  timeout: 30000,
  stale: 10000,
  retries: 300, // 300 retries * 100ms = 30s
}

/** Lock release function */
export type ReleaseFn = () => Promise<void>

/** Lock handle returned by lock acquisition */
export interface LockHandle {
  /** Release the lock */
  release: ReleaseFn
  /** Path that is locked */
  path: string
}

/**
 * Ensure parent directory exists for a lock file
 */
async function ensureLockDir(lockPath: string): Promise<void> {
  const dir = path.dirname(lockPath)
  await fs.promises.mkdir(dir, { recursive: true })
}

/**
 * Ensure a file exists (create empty if needed) for locking
 */
async function ensureLockFile(lockPath: string): Promise<void> {
  await ensureLockDir(lockPath)
  try {
    await fs.promises.access(lockPath)
  } catch {
    // File doesn't exist, create it
    await fs.promises.writeFile(lockPath, '')
  }
}

/**
 * Acquire a lock on a file
 *
 * @param lockPath - Path to lock (will create if needed)
 * @param options - Lock options
 * @returns Lock handle with release function
 * @throws LockTimeoutError if lock cannot be acquired within timeout
 * @throws LockError for other lock failures
 */
export async function acquireLock(
  lockPath: string,
  options: LockOptions = {}
): Promise<LockHandle> {
  const opts = { ...DEFAULT_LOCK_OPTIONS, ...options }

  // Ensure the lock file exists
  await ensureLockFile(lockPath)

  try {
    const release = await lockfile.lock(lockPath, {
      stale: opts.stale,
      retries: {
        retries: opts.retries,
        minTimeout: 100,
        maxTimeout: 200,
        factor: 1,
      },
    })

    return {
      release: async () => {
        try {
          await release()
        } catch (err) {
          // Ignore errors when releasing (lock may already be released)
          if (err instanceof Error && !err.message.includes('not acquired')) {
            throw new LockError(`Failed to release lock: ${err.message}`, lockPath)
          }
        }
      },
      path: lockPath,
    }
  } catch (err) {
    if (err instanceof Error) {
      if (err.message.includes('ELOCKED')) {
        throw new LockTimeoutError(lockPath, opts.timeout)
      }
      throw new LockError(err.message, lockPath)
    }
    throw new LockError(String(err), lockPath)
  }
}

/**
 * Check if a file is currently locked
 *
 * @param lockPath - Path to check
 * @returns true if the file is locked
 */
export async function isLocked(lockPath: string): Promise<boolean> {
  try {
    await fs.promises.access(lockPath)
    return lockfile.check(lockPath)
  } catch {
    // File doesn't exist, so it's not locked
    return false
  }
}

/**
 * Execute a function with a lock held
 *
 * @param lockPath - Path to lock
 * @param fn - Function to execute while holding the lock
 * @param options - Lock options
 * @returns Result of the function
 */
export async function withLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  const handle = await acquireLock(lockPath, options)
  try {
    return await fn()
  } finally {
    await handle.release()
  }
}

// ============================================================================
// High-level lock helpers for ASP
// ============================================================================

/** Lock file names */
export const LOCK_FILES = {
  /** Project-level lock (prevents concurrent installs/runs in same project) */
  PROJECT: '.asp.lock',
  /** Global store lock (prevents concurrent store modifications) */
  STORE: 'store.lock',
} as const

/**
 * Get the project lock file path
 *
 * @param projectRoot - Path to project root (directory containing asp-targets.toml)
 * @returns Path to the project lock file
 */
export function getProjectLockPath(projectRoot: string): string {
  return path.join(projectRoot, LOCK_FILES.PROJECT)
}

/**
 * Get the global store lock file path
 *
 * @param aspHome - ASP_HOME directory (default: ~/.asp)
 * @returns Path to the store lock file
 */
export function getStoreLockPath(aspHome: string): string {
  return path.join(aspHome, LOCK_FILES.STORE)
}

/**
 * Execute a function with the project lock held
 *
 * @param projectRoot - Path to project root
 * @param fn - Function to execute
 * @param options - Lock options
 * @returns Result of the function
 */
export async function withProjectLock<T>(
  projectRoot: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  return withLock(getProjectLockPath(projectRoot), fn, options)
}

/**
 * Execute a function with the store lock held
 *
 * @param aspHome - ASP_HOME directory
 * @param fn - Function to execute
 * @param options - Lock options
 * @returns Result of the function
 */
export async function withStoreLock<T>(
  aspHome: string,
  fn: () => Promise<T>,
  options: LockOptions = {}
): Promise<T> {
  return withLock(getStoreLockPath(aspHome), fn, options)
}
