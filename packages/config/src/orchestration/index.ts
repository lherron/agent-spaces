/**
 * Config-time orchestration for Agent Spaces.
 *
 * High-level entrypoints that coordinate resolution, store, and materialization.
 */

// Resolution
export {
  resolveTarget,
  resolveTargets,
  loadProjectManifest,
  loadLockFileIfExists,
  getRegistryPath,
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
  materializeTarget,
  type InstallOptions,
  type InstallResult,
  type TargetMaterializationResult,
} from './install.js'

// Low-level materialization from refs
export {
  materializeFromRefs,
  discoverSkills,
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
