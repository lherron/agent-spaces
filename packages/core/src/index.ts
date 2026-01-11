/**
 * @agent-spaces/core
 *
 * Core library for Agent Spaces v2
 * Provides types, schemas, config parsing, errors, locks, and atomic writes.
 */

// Types
export * from './types/index.js'

// Schemas
export {
  distTagsSchema,
  lockSchema,
  spaceSchema,
  targetsSchema,
  validateDistTagsFile,
  validateLockFile,
  validateProjectManifest,
  validateSpaceManifest,
} from './schemas/index.js'
export type { ValidationError, ValidationResult } from './schemas/index.js'

// Config parsers
export {
  LOCK_FILENAME,
  lockFileExists,
  parseLockJson,
  parseSpaceToml,
  parseTargetsToml,
  readLockJson,
  readSpaceToml,
  readTargetsToml,
  serializeLockJson,
  serializeSpaceToml,
  serializeTargetsToml,
  TARGETS_FILENAME,
} from './config/index.js'

// asp_modules directory helpers
export {
  ASP_MODULES_DIR,
  ASP_MODULES_MCP_CONFIG,
  ASP_MODULES_PLUGINS_DIR,
  ASP_MODULES_SETTINGS,
  aspModulesExists,
  getAspModulesPath,
  getTargetMcpConfigPath,
  getTargetOutputPath,
  getTargetPluginsPath,
  getTargetSettingsPath,
  targetOutputExists,
  // Phase 2: Harness-aware path helpers
  getHarnessOutputPath,
  getHarnessPluginsPath,
  getHarnessMcpConfigPath,
  getHarnessSettingsPath,
  harnessOutputExists,
} from './config/index.js'

// Errors
export {
  AspError,
  ClaudeError,
  ClaudeInvocationError,
  ClaudeNotFoundError,
  ConfigError,
  ConfigParseError,
  ConfigValidationError,
  CyclicDependencyError,
  GitError,
  IntegrityError,
  isAspError,
  isClaudeError,
  isConfigError,
  isGitError,
  isResolutionError,
  isStoreError,
  LockError,
  LockTimeoutError,
  MaterializationError,
  MissingDependencyError,
  RefParseError,
  ResolutionError,
  SelectorResolutionError,
  SnapshotError,
  StoreError,
} from './errors.js'

// Locks
export {
  acquireLock,
  getProjectLockPath,
  getStoreLockPath,
  isLocked,
  LOCK_FILES,
  withLock,
  withProjectLock,
  withStoreLock,
} from './locks.js'
export type { LockHandle, LockOptions, ReleaseFn } from './locks.js'

// Atomic file operations
export {
  atomicDir,
  atomicWrite,
  atomicWriteJson,
  copyDir,
  copyFile,
  linkOrCopy,
} from './atomic.js'
export type { AtomicWriteOptions } from './atomic.js'
