/**
 * Content-addressed storage for Agent Spaces v2.
 *
 * WHY: This package manages the local storage of space snapshots
 * and materialized plugin cache. It provides:
 * - Path management for ASP_HOME structure
 * - Snapshot extraction and verification
 * - Plugin cache management
 * - Garbage collection
 */

// Path management
export {
  DEFAULT_ASP_HOME,
  getAspHome,
  getRepoPath,
  getSnapshotsPath,
  getStorePath, // deprecated, use getSnapshotsPath
  getCachePath,
  getTempPath,
  getSnapshotPath,
  getPluginCachePath,
  getSpacesPath,
  getSpaceSourcePath,
  getRegistryMetaPath,
  getDistTagsPath,
  getGlobalLockPath,
  ensureDir,
  ensureAspHome,
  PathResolver,
  type PathOptions,
} from './paths.js'

// Snapshot operations
export {
  snapshotExists,
  getSnapshotMetadata,
  createSnapshot,
  verifySnapshot,
  deleteSnapshot,
  listSnapshots,
  getSnapshotSize,
  type SnapshotMetadata,
  type SnapshotOptions,
} from './snapshot.js'

// Cache operations
export {
  computePluginCacheKey,
  cacheExists,
  getCacheMetadata,
  writeCacheMetadata,
  deleteCache,
  listCacheEntries,
  getCacheSize,
  getTotalCacheSize,
  pruneCache,
  type CacheMetadata,
  type CacheOptions,
} from './cache.js'

// Garbage collection
export {
  computeReachableIntegrities,
  computeReachableCacheKeys,
  runGC,
  checkGC,
  type GCResult,
  type GCOptions,
} from './gc.js'
