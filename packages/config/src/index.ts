/**
 * spaces-config: Config-time determinism
 *
 * This package provides all config-time functionality:
 * - Core types, schemas, config parsing, errors, locks, atomic writes
 * - Git operations (shell-out wrapper)
 * - Resolution engine (refs → commits → closure → lock)
 * - Content-addressed storage (snapshots, cache)
 * - Plugin directory generation (materialization)
 * - Linting rules
 * - Config-time orchestration (install, build, explain)
 */

// Core - foundation types, schemas, config, errors, locks, atomic ops
export * from './core/index.js'

// Git operations - exported as namespace to avoid potential conflicts
export * as git from './git/index.js'
// Also export commonly used git functions directly
export {
  gitExec,
  gitExecLines,
  gitExecStdout,
  getTagCommit,
  listTagsWithCommits,
  showFile,
  showFileOrNull,
  showJson,
  extractTree,
  listTreeRecursive,
  filterTreeEntries,
  fetch,
  cloneRepo,
  getHead,
  isGitRepo,
  // Additional git functions used by CLI
  listRemotes,
  getStatus,
  listTags,
  createAnnotatedTag,
  initRepo,
  createTag,
  commit,
  add,
} from './git/index.js'

// Resolver - exported as namespace since it has some overlapping names with core
export * as resolver from './resolver/index.js'
// Export resolver functions that don't conflict
export {
  // Ref parsing (resolver version extends core's)
  parseSpaceRef,
  parseSelector,
  formatSpaceRef,
  asSpaceId,
  // Dist tags
  readDistTags,
  resolveDistTag,
  // Git tags
  buildTagPattern,
  listVersionTags,
  resolveSemverRange,
  resolveExactVersion,
  getLatestVersion,
  versionExists,
  resolveSelector,
  // Selector resolution
  resolveSpaceRef,
  resolveSpaceRefs,
  // Closure
  computeClosure,
  getSpace,
  getSpacesInOrder,
  // Integrity
  computeIntegrity,
  verifyIntegrity,
  // Lock generation
  generateLockFileForTarget,
  mergeLockFiles,
  DEV_COMMIT_MARKER,
  DEV_INTEGRITY,
  // Manifest
  readSpaceManifest,
  readSpaceManifestOrNull,
} from './resolver/index.js'

// Store - content-addressed storage
export * from './store/index.js'

// Materializer - plugin directory generation
export * from './materializer/index.js'

// Lint - exported as namespace since it has some overlapping names
export * as lint from './lint/index.js'
// Export lint functions that don't conflict
export {
  lint as lintSpaces,
  formatWarnings,
  formatText as formatLintText,
  formatJson as formatLintJson,
  WARNING_CODES,
  type LintWarning,
  type LintRule,
  type LintContext,
  type SpaceLintData,
  type WarningCode,
} from './lint/index.js'

// Orchestration - config-time workflows
export * from './orchestration/index.js'
