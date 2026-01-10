/**
 * @agent-spaces/engine - High-level orchestration for Agent Spaces v2.
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
  type InstallOptions,
  type InstallResult,
} from './install.js'

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
  type RunOptions,
  type RunResult,
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
