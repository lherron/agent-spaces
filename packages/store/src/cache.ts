/**
 * Plugin cache management.
 *
 * WHY: Materialized plugins are cached by their cache key to avoid
 * re-materialization on every run. This significantly speeds up repeated runs.
 */

import { createHash } from 'node:crypto'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sha256Integrity, SpaceKey } from '@agent-spaces/core'
import { type PathResolver, ensureDir } from './paths.js'

/**
 * Compute a plugin cache key.
 *
 * Formula (v1 - legacy, without harness):
 * sha256("materializer-v1\0" + spaceIntegrity + "\0" + pluginName + "\0" + pluginVersion + "\n")
 *
 * Note: This function is kept for backward compatibility. New code should use
 * computeHarnessPluginCacheKey() which includes the harness ID in the cache key.
 */
export function computePluginCacheKey(
  integrity: Sha256Integrity,
  pluginName: string,
  pluginVersion: string
): string {
  const hash = createHash('sha256')
  hash.update(`materializer-v1\0${integrity}\0${pluginName}\0${pluginVersion}\n`)
  return hash.digest('hex')
}

/**
 * Compute a harness-aware plugin cache key (Phase 2).
 *
 * Formula:
 * sha256("materializer-v2\0" + harnessId + "\0" + harnessVersion + "\0" + spaceIntegrity + "\0" + pluginName + "\0" + pluginVersion + "\n")
 *
 * This includes the harness ID and version in the cache key so that the same
 * space produces different cached artifacts for different harnesses (e.g., Claude vs Pi).
 */
export function computeHarnessPluginCacheKey(
  harnessId: string,
  harnessVersion: string,
  integrity: Sha256Integrity,
  pluginName: string,
  pluginVersion: string
): string {
  const hash = createHash('sha256')
  hash.update(
    `materializer-v2\0${harnessId}\0${harnessVersion}\0${integrity}\0${pluginName}\0${pluginVersion}\n`
  )
  return hash.digest('hex')
}

/**
 * Cache entry metadata.
 */
export interface CacheMetadata {
  /** Plugin name */
  pluginName: string
  /** Plugin version */
  pluginVersion: string
  /** Source space integrity */
  integrity: Sha256Integrity
  /** Cache key */
  cacheKey: string
  /** When the cache entry was created */
  createdAt: string
  /** Space key (id@commit) */
  spaceKey: SpaceKey
}

/**
 * Options for cache operations.
 */
export interface CacheOptions {
  /** Path resolver for storage locations */
  paths: PathResolver
}

/**
 * Check if a cached plugin exists.
 */
export async function cacheExists(cacheKey: string, options: CacheOptions): Promise<boolean> {
  const cachePath = options.paths.pluginCache(cacheKey)
  try {
    const stats = await stat(cachePath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Get cache entry metadata if it exists.
 */
export async function getCacheMetadata(
  cacheKey: string,
  options: CacheOptions
): Promise<CacheMetadata | null> {
  const cachePath = options.paths.pluginCache(cacheKey)
  const metaPath = join(cachePath, '.asp-cache.json')

  try {
    const content = await readFile(metaPath, 'utf-8')
    return JSON.parse(content) as CacheMetadata
  } catch {
    return null
  }
}

/**
 * Write cache entry metadata.
 */
export async function writeCacheMetadata(
  cacheKey: string,
  metadata: CacheMetadata,
  options: CacheOptions
): Promise<void> {
  const cachePath = options.paths.pluginCache(cacheKey)
  const metaPath = join(cachePath, '.asp-cache.json')

  await ensureDir(cachePath)
  await writeFile(metaPath, JSON.stringify(metadata, null, 2))
}

/**
 * Delete a cache entry.
 */
export async function deleteCache(cacheKey: string, options: CacheOptions): Promise<void> {
  const cachePath = options.paths.pluginCache(cacheKey)
  await rm(cachePath, { recursive: true, force: true })
}

/**
 * List all cache entries.
 */
export async function listCacheEntries(options: CacheOptions): Promise<string[]> {
  try {
    const items = await readdir(options.paths.cache, { withFileTypes: true })
    const cacheKeys: string[] = []

    for (const item of items) {
      if (item.isDirectory() && /^[0-9a-f]{64}$/.test(item.name)) {
        cacheKeys.push(item.name)
      }
    }

    return cacheKeys
  } catch {
    return []
  }
}

/**
 * Get the size of a cache entry in bytes.
 */
export async function getCacheSize(cacheKey: string, options: CacheOptions): Promise<number> {
  const cachePath = options.paths.pluginCache(cacheKey)
  return computeDirSize(cachePath)
}

async function computeDirSize(dirPath: string): Promise<number> {
  let size = 0
  try {
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
  } catch {
    // Directory might not exist
  }

  return size
}

/**
 * Get total cache size in bytes.
 */
export async function getTotalCacheSize(options: CacheOptions): Promise<number> {
  const entries = await listCacheEntries(options)
  let total = 0

  for (const cacheKey of entries) {
    total += await getCacheSize(cacheKey, options)
  }

  return total
}

/**
 * Prune cache entries not in the reachable set.
 */
export async function pruneCache(reachable: Set<string>, options: CacheOptions): Promise<number> {
  const entries = await listCacheEntries(options)
  let pruned = 0

  for (const cacheKey of entries) {
    if (!reachable.has(cacheKey)) {
      await deleteCache(cacheKey, options)
      pruned++
    }
  }

  return pruned
}
