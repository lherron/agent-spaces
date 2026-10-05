/**
 * ASP_HOME temp locations shared by the plugin-artifact and target-bundle
 * materialization pipelines: unique per-process staging directories and the
 * cross-process lock files that serialize cache/bundle publication.
 */

import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

import { type PathResolver, sanitizeProjectAgentScopeSegment } from '../store/index.js'

export function materializationLockPath(paths: PathResolver, key: string): string {
  const safeKey = sanitizeProjectAgentScopeSegment(key)
  return join(paths.temp, 'locks', `${safeKey}.lock`)
}

export function uniqueStagingDir(paths: PathResolver, prefix: string): string {
  return join(paths.temp, '.staging', `${prefix}-${process.pid}-${randomUUID()}`)
}
