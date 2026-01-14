/**
 * Dist-tags resolution from registry metadata.
 *
 * WHY: Dist-tags provide stable channel names (stable, latest, beta)
 * that map to specific versions without needing semver resolution.
 */

import type { DistTagsFile, SpaceId } from 'spaces-core'
import { showFileOrNull } from 'spaces-git'

// Re-export for backwards compatibility
export type { DistTagsFile } from 'spaces-core'

/**
 * Options for dist-tags operations.
 */
export interface DistTagsOptions {
  /** Working directory (registry repo root) */
  cwd: string
  /** Git ref to read from (default: HEAD) */
  ref?: string | undefined
}

/**
 * Read the dist-tags.json file from the registry.
 * Returns null if the file doesn't exist.
 */
export async function readDistTags(options: DistTagsOptions): Promise<DistTagsFile | null> {
  const ref = options.ref ?? 'HEAD'
  const path = 'registry/dist-tags.json'

  // showFileOrNull takes (commitish, path, options)
  const content = await showFileOrNull(ref, path, { cwd: options.cwd })
  if (content === null) {
    return null
  }

  try {
    return JSON.parse(content) as DistTagsFile
  } catch {
    return null
  }
}

/**
 * Resolve a dist-tag to a version string.
 * Returns the version (e.g., "v1.2.3") or null if not found.
 */
export async function resolveDistTag(
  spaceId: SpaceId,
  tagName: string,
  options: DistTagsOptions
): Promise<string | null> {
  const distTags = await readDistTags(options)
  if (distTags === null) {
    return null
  }

  const spaceTags = distTags[spaceId]
  if (!spaceTags) {
    return null
  }

  return spaceTags[tagName] ?? null
}

/**
 * Get all available dist-tags for a space.
 */
export async function getDistTagsForSpace(
  spaceId: SpaceId,
  options: DistTagsOptions
): Promise<Record<string, string>> {
  const distTags = await readDistTags(options)
  if (distTags === null) {
    return {}
  }

  return distTags[spaceId] ?? {}
}

/**
 * Get all spaces that have dist-tags.
 */
export async function getAllDistTagSpaces(options: DistTagsOptions): Promise<SpaceId[]> {
  const distTags = await readDistTags(options)
  if (distTags === null) {
    return []
  }

  return Object.keys(distTags) as SpaceId[]
}

/**
 * Convert a version string to the expected git tag format.
 * e.g., "v1.2.3" or "1.2.3" -> "space/<id>/v1.2.3"
 */
export function versionToGitTag(spaceId: SpaceId, version: string): string {
  // Normalize version to include 'v' prefix
  const normalizedVersion = version.startsWith('v') ? version : `v${version}`
  return `space/${spaceId}/${normalizedVersion}`
}
