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
  isAgentSpaceRef,
  isProjectSpaceRef,
  isSha256Integrity,
  isSpaceId,
  isSpaceKey,
  isSpaceRefString,
  parseSelector,
  parseSpaceKey,
  parseSpaceRef,
  partitionDevRefs,
  partitionProjectRefs,
  AGENT_COMMIT_MARKER,
  PROJECT_COMMIT_MARKER,
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
  CodexOptions,
  ProjectManifest,
  ResolverConfig,
  TargetDefinition,
  TargetName,
} from './targets.js'

export {
  getEffectiveClaudeOptions,
  getEffectiveCodexOptions,
  getTarget,
  getTargetNames as getProjectTargetNames,
  mergeClaudeOptions,
  mergeCodexOptions,
  mergeManifests,
} from './targets.js'

// Dist-tags types
export type { DistTagsFile } from './dist-tags.js'

// Agent runtime profile types
export type {
  AgentIdentity,
  AgentProfileInstructions,
  AgentProfileSession,
  AgentProfileSpaces,
  AgentProfileTarget,
  AgentRuntimeProfile,
  HarnessSettings,
  RunMode,
} from './agent-profile.js'

// Placement types
export type {
  HostCorrelation,
  ResolvedInstruction,
  ResolvedRuntimeBundle,
  ResolvedSpace,
  RunScaffoldPacket,
  RuntimeBundleRef,
  RuntimePlacement,
} from './placement.js'

export { createRuntimePlacement, isValidBundleRefKind, isValidRunMode } from './placement.js'

// Lock file types
export type {
  LockFile,
  LockHarnessEntry,
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

// Harness types (multi-harness support)
export type {
  ComposedTargetBundle,
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  HarnessAdapter,
  HarnessDetection,
  HarnessId,
  HarnessModelInfo,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ResolvedSpaceArtifact,
  SpaceClaudeConfig,
  SpaceCodexConfig,
  SpaceHarnessConfig,
  SpaceHarnessManifestExtension,
  SpacePiBuildConfig,
  SpacePiConfig,
} from './harness.js'

export {
  DEFAULT_HARNESS,
  HARNESS_IDS,
  isHarnessSupported,
  isHarnessId,
} from './harness.js'

// Agent-local components types (agent-local skills/commands auto-discovery)
export type { AgentLocalComponents } from './agent-local.js'
