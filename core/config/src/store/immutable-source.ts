import { stat } from 'node:fs/promises'

import type { PortableLockRegistry } from '../core/index.js'
import { cloneRepo, fetch, isGitRepo, listRemotes } from '../git/index.js'
import { type PathResolver, ensureDir } from './paths.js'

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Ensure the ASP-owned node-local mirror for a portable immutable source.
 *
 * The returned path is placement state only. It must never be serialized into
 * a portable lock, whose registry field carries only `repository` and
 * `canonicalRemote`.
 */
export async function ensureImmutableSourceMirror(
  registry: PortableLockRegistry,
  paths: PathResolver,
  options: { fetch?: boolean | undefined } = {}
): Promise<string> {
  const mirrorPath = paths.immutableRepository(registry.repository)
  await ensureDir(paths.sources)

  if (!(await pathExists(mirrorPath))) {
    await cloneRepo(registry.canonicalRemote, mirrorPath)
  } else if (!(await isGitRepo(mirrorPath))) {
    throw new Error(`Immutable source placement exists but is not a git repository: ${mirrorPath}`)
  }

  const origin = (await listRemotes({ cwd: mirrorPath })).find((remote) => remote.name === 'origin')
  if (!origin || origin.fetchUrl !== registry.canonicalRemote) {
    throw new Error(
      `Immutable source mirror origin mismatch for ${registry.repository}: ` +
        `${origin?.fetchUrl ?? '<missing>'} != ${registry.canonicalRemote}`
    )
  }

  if (options.fetch !== false) {
    await fetch('origin', { cwd: mirrorPath, prune: true, tags: true })
  }

  return mirrorPath
}
