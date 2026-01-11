/**
 * Space resolution engine for Agent Spaces v2.
 *
 * WHY: This package handles the complete resolution process:
 * - Parse space references
 * - Resolve selectors to commits (dist-tags, semver, git pins)
 * - Compute dependency closures
 * - Generate lock files
 * - Validate resolution results
 */

// Re-export ref parsing
export {
  parseSpaceRef,
  parseSpaceRefCore,
  parseSelector,
  formatSpaceRef,
  isSpaceRefString,
  buildSpaceKey,
  parseSpaceKey,
  parseAllRefs,
  asSpaceId,
  asCommitSha,
  asSpaceKey,
  type SpaceRef,
  type SpaceRefString,
  type Selector,
  type SpaceId,
  type CommitSha,
  type SpaceKey,
} from './ref-parser.js'

// Dist-tags
export {
  readDistTags,
  resolveDistTag,
  getDistTagsForSpace,
  getAllDistTagSpaces,
  versionToGitTag,
  type DistTagsFile,
  type DistTagsOptions,
} from './dist-tags.js'

// Git tags
export {
  buildTagPattern,
  parseVersionTag,
  listVersionTags,
  resolveExactVersion,
  resolveSemverRange,
  getLatestVersion,
  versionExists,
  type VersionInfo,
  type GitTagOptions,
} from './git-tags.js'

// Selector resolution
export {
  resolveSelector,
  resolveSpaceRef,
  resolveSpaceRefs,
  type ResolvedSelector,
  type SelectorResolveOptions,
} from './selector.js'

// Manifest reading
export {
  readSpaceManifest,
  readSpaceManifestOrNull,
  readSpaceManifestFromFilesystem,
  getSpaceDependencies,
  hasDependencies,
  type ManifestReadOptions,
} from './manifest.js'

// Closure computation
export {
  DEV_COMMIT_MARKER,
  computeClosure,
  getSpace,
  getSpacesInOrder,
  isRoot,
  getDependents,
  type ResolvedSpace,
  type ClosureResult,
  type ClosureOptions,
} from './closure.js'

// Integrity hashing
export {
  DEV_INTEGRITY,
  computeIntegrity,
  computeEnvHash,
  verifyIntegrity,
  type IntegrityOptions,
} from './integrity.js'

// Lock file generation
export {
  generateLockFile,
  generateLockFileForTarget,
  mergeLockFiles,
  isTargetUpToDate,
  type LockGeneratorOptions,
  type TargetInput,
} from './lock-generator.js'

// Validation
export {
  validateSpaceManifest,
  validateProjectManifest,
  validateClosure,
  validateLockFile,
  type ValidationError,
  type ValidationResult,
} from './validator.js'
