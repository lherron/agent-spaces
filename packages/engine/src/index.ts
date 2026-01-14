/**
 * spaces-engine - High-level orchestration for Agent Spaces v2.
 *
 * WHY: This package provides high-level entrypoints that coordinate
 * the resolver, store, materializer, claude, and lint packages.
 *
 * The engine is the primary interface for:
 * - Installing (resolving + populating store)
 * - Building (materializing to plugin directories)
 * - Running (launching Claude with plugins)
 * - Explaining (debugging resolution)
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

// Running
export {
  run,
  runWithPrompt,
  runInteractive,
  runGlobalSpace,
  runLocalSpace,
  isSpaceReference,
  type RunOptions,
  type RunResult,
  type GlobalRunOptions,
} from './run.js'

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

// Harness (multi-harness support)
export {
  HarnessRegistry,
  harnessRegistry,
  ClaudeAdapter,
  claudeAdapter,
  DEFAULT_HARNESS,
  HARNESS_IDS,
  isHarnessId,
} from './harness/index.js'

export type {
  ComposedTargetBundle,
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  HarnessAdapter,
  HarnessDetection,
  HarnessId,
  HarnessRunOptions,
  HarnessValidationResult,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ResolvedSpaceArtifact,
} from './harness/index.js'
