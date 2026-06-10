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
  getProjectsPath,
  getTempPath,
  getSnapshotPath,
  getPluginCachePath,
  sanitizeProjectAgentScopeSegment,
  getProjectAgentScopeId,
  getProjectAgentScopePath,
  getProjectStorageId,
  getProjectDataPath,
  getProjectTargetsPath,
  getProjectHarnessBundleRootPath,
  getProjectHarnessOutputPath,
  getLegacyProjectStorageId,
  getLegacyProjectHarnessOutputPath,
  projectHarnessOutputExists,
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
export { getAgentsRoot } from './asp-config.js'
export {
  buildRuntimeBundleRef,
  findProjectMarker,
  inferProjectIdFromCwd,
  PROJECT_MARKER_FILENAME,
  resolveAgentPlacementPaths,
  type InferProjectIdFromCwdOptions,
  type ProjectMarker,
  type ResolvedAgentPlacementPaths,
  type ResolveAgentPlacementPathsOptions,
  type RuntimeBundleRefOptions,
} from './runtime-placement.js'

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
  computeHarnessPluginCacheKey,
  cacheExists,
  getCacheMetadata,
  writeCacheMetadata,
  writeCacheMetadataAt,
  deleteCache,
  listCacheEntries,
  getCacheSize,
  getTotalCacheSize,
  pruneCache,
  type CacheMetadata,
  type CacheOptions,
  type CacheRequiredEntry,
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

// Temp lifecycle
export {
  DEFAULT_LAUNCH_OVERLAY_MAX_AGE_MS,
  DEFAULT_STAGING_MAX_AGE_MS,
  sweepAspTempArtifacts,
  writeRuntimeSystemPromptArtifact,
  type AspTempSweepResult,
  type RuntimeSystemPromptArtifact,
  type SweepAspTempArtifactsOptions,
  type TempSweepStats,
  type WriteRuntimeSystemPromptArtifactInput,
} from './temp-lifecycle.js'
