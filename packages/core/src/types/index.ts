/**
 * Core types for Agent Spaces v2
 */

// Reference types
export type {
  CommitSha,
  DistTagName,
  Selector,
  SelectorKind,
  Sha256Integrity,
  SpaceId,
  SpaceKey,
  SpaceRef,
  SpaceRefString,
} from './refs.js'

export {
  asCommitSha,
  asSha256Integrity,
  asSpaceId,
  asSpaceKey,
  formatSpaceRef,
  isCommitSha,
  isDevRef,
  isKnownDistTag,
  isSha256Integrity,
  isSpaceId,
  isSpaceKey,
  isSpaceRefString,
  parseSelector,
  parseSpaceKey,
  parseSpaceRef,
  partitionDevRefs,
} from './refs.js'

// Space manifest types
export type {
  PluginIdentity,
  ResolvedSpaceManifest,
  SpaceAuthor,
  SpaceDeps,
  SpaceManifest,
  SpacePermissions,
  SpacePluginConfig,
  SpaceSettings,
} from './space.js'

export { derivePluginIdentity, resolveSpaceManifest } from './space.js'

// Project targets types
export type {
  ClaudeOptions,
  ProjectManifest,
  ResolverConfig,
  TargetDefinition,
  TargetName,
} from './targets.js'

export {
  getEffectiveClaudeOptions,
  getTarget,
  getTargetNames as getProjectTargetNames,
  mergeClaudeOptions,
} from './targets.js'

// Dist-tags types
export type { DistTagsFile } from './dist-tags.js'

// Lock file types
export type {
  LockFile,
  LockPluginInfo,
  LockRegistry,
  LockSpaceDeps,
  LockSpaceEntry,
  LockTargetEntry,
  LockWarning,
  ResolvedFrom,
} from './lock.js'

export {
  createEmptyLockFile,
  getAllSpaceKeys,
  getLoadOrderEntries,
  getSpaceEntry,
  getTargetEntry,
  getTargetNames as getLockTargetNames,
  hasTarget,
} from './lock.js'
