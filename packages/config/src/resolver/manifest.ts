/**
 * Space manifest reading from git and filesystem.
 *
 * WHY: Resolution needs to read space.toml from specific commits
 * to resolve transitive dependencies. For @dev refs, we read from
 * the working directory instead.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import TOML from '@iarna/toml'
import type { CommitSha, SpaceId, SpaceManifest, SpaceRefString } from '../core/index.js'
import { ConfigParseError, validateSpaceManifest as coreValidateManifest } from '../core/index.js'
import { showFileOrNull } from '../git/index.js'

/**
 * Options for manifest reading.
 */
export interface ManifestReadOptions {
  /** Working directory (registry repo root) */
  cwd: string
}

/**
 * Read a space manifest from a specific commit.
 * Throws if the manifest doesn't exist or is invalid.
 */
export async function readSpaceManifest(
  spaceId: SpaceId,
  commit: CommitSha,
  options: ManifestReadOptions
): Promise<SpaceManifest> {
  const path = `spaces/${spaceId}/space.toml`

  // showFileOrNull takes (commitish, path, options)
  const content = await showFileOrNull(commit, path, { cwd: options.cwd })
  if (content === null) {
    throw new ConfigParseError(`Space manifest not found at ${commit}:${path}`, path)
  }

  try {
    const data = TOML.parse(content)
    const result = coreValidateManifest(data)
    if (!result.valid) {
      throw new ConfigParseError(
        `Invalid space manifest: ${result.errors.map((e) => e.message).join(', ')}`,
        path
      )
    }
    return result.data
  } catch (err) {
    if (err instanceof ConfigParseError) {
      throw err
    }
    throw new ConfigParseError(
      `Failed to parse space manifest: ${err instanceof Error ? err.message : String(err)}`,
      path
    )
  }
}

/**
 * Get the dependencies from a space manifest.
 */
export function getSpaceDependencies(manifest: SpaceManifest): SpaceRefString[] {
  return manifest.deps?.spaces ?? []
}

/**
 * Check if a space manifest has any dependencies.
 */
export function hasDependencies(manifest: SpaceManifest): boolean {
  return getSpaceDependencies(manifest).length > 0
}

/**
 * Read a space manifest if it exists, returning null otherwise.
 */
export async function readSpaceManifestOrNull(
  spaceId: SpaceId,
  commit: CommitSha,
  options: ManifestReadOptions
): Promise<SpaceManifest | null> {
  try {
    return await readSpaceManifest(spaceId, commit, options)
  } catch {
    return null
  }
}

/**
 * Read a space manifest from the filesystem (working directory).
 * Used for @dev refs that point to uncommitted local changes.
 *
 * @param spaceIdOrPath - Space ID (for registry-based refs) or absolute path to space dir (for path refs)
 * @param options - ManifestReadOptions with cwd
 */
export async function readSpaceManifestFromFilesystem(
  spaceIdOrPath: SpaceId | string,
  options: ManifestReadOptions
): Promise<SpaceManifest> {
  // Determine if this is a path ref (absolute/relative path) or a space ID
  const isPathRef = spaceIdOrPath.includes('/') || spaceIdOrPath.includes('\\')
  const path = isPathRef
    ? join(spaceIdOrPath, 'space.toml') // Path ref: use path directly
    : join(options.cwd, 'spaces', spaceIdOrPath, 'space.toml') // ID ref: use registry structure

  let content: string
  try {
    content = await readFile(path, 'utf-8')
  } catch (err) {
    throw new ConfigParseError(
      `Space manifest not found: ${err instanceof Error ? err.message : String(err)}`,
      path
    )
  }

  try {
    const data = TOML.parse(content)
    const result = coreValidateManifest(data)
    if (!result.valid) {
      throw new ConfigParseError(
        `Invalid space manifest: ${result.errors.map((e) => e.message).join(', ')}`,
        path
      )
    }
    return result.data
  } catch (err) {
    if (err instanceof ConfigParseError) {
      throw err
    }
    throw new ConfigParseError(
      `Failed to parse space manifest: ${err instanceof Error ? err.message : String(err)}`,
      path
    )
  }
}
