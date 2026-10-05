/**
 * Config-time orchestration for Agent Spaces.
 *
 * High-level entrypoints that coordinate resolution, store, and materialization.
 */

// Resolution
export {
  resolveTarget,
  resolveTargets,
  resolveComposeRefs,
  loadProjectManifest,
  loadLockFileIfExists,
  getRegistryPath,
  getImmutableRegistryPath,
  ensureImmutableRegistry,
  deferImmutableRegistry,
  refreshImmutableRegistryIfPresent,
  getSpacesInOrder,
  type ResolveOptions,
  type ResolveResult,
} from './resolve.js'

// Installation
export {
  install,
  installNeeded,
  ensureRegistry,
  populateStore,
  writeLockFile,
  type InstallOptions,
  type InstallResult,
} from './install.js'
export { materializeTarget, type TargetMaterializationResult } from './materialize-target.js'
export { materializeAgentLocalComponents } from './plugin-artifacts.js'

// Low-level materialization from refs
export {
  materializeFromRefs,
  discoverSkills,
  detectCommandConflicts,
  type MaterializeFromRefsOptions,
  type MaterializeFromRefsResult,
  type SkillMetadata,
} from './materialize-refs.js'

// Building
export {
  build,
  buildAll,
  type BuildOptions,
  type BuildResult,
} from './build.js'

// Explaining
export {
  explain,
  formatExplainText,
  formatExplainJson,
  type ExplainOptions,
  type ExplainResult,
  type TargetExplanation,
  type SpaceInfo,
} from './explain.js'
