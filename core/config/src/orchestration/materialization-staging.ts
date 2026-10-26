/**
 * ASP_HOME temp locations shared by the plugin-artifact and target-bundle
 * materialization pipelines: unique per-process staging directories and the
 * cross-process lock files that serialize cache/bundle publication and lock
 * file merges.
 */

import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

import { withLock } from '../core/index.js'
import { type PathResolver, sanitizeProjectAgentScopeSegment } from '../store/index.js'

export function materializationLockPath(paths: PathResolver, key: string): string {
  const safeKey = sanitizeProjectAgentScopeSegment(key)
  return join(paths.temp, 'locks', `${safeKey}.lock`)
}

export function uniqueStagingDir(paths: PathResolver, prefix: string): string {
  return join(paths.temp, '.staging', `${prefix}-${process.pid}-${randomUUID()}`)
}

/**
 * Run a lock file's read-merge-write (global-lock.json) under that file's
 * cross-process lock, so concurrent compiles never drop each other's merged
 * entries. Hold it only across the read-merge-write.
 */
export function withLockFileMerge<T>(
  paths: PathResolver,
  lockPath: string,
  fn: () => Promise<T>
): Promise<T> {
  const key = createHash('sha256').update(resolve(lockPath)).digest('hex').slice(0, 32)
  return withLock(materializationLockPath(paths, `lock-file-${key}`), fn, {
    stale: 60_000,
    retries: 600,
  })
}
