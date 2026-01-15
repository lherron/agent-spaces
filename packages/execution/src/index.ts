/**
 * spaces-execution: Run-time volatility
 *
 * This package provides all runtime execution functionality:
 * - Claude CLI detection and invocation
 * - Harness adapters (Claude, Pi, Pi SDK)
 * - Running agents with plugins
 * - Install/materialize with harness support
 */

import {
  type BuildResult,
  type BuildOptions as ConfigBuildOptions,
  type InstallOptions as ConfigInstallOptions,
  type MaterializeFromRefsOptions as ConfigMaterializeFromRefsOptions,
  DEFAULT_HARNESS,
  type InstallResult,
  type LockFile,
  type MaterializeFromRefsResult,
  type TargetMaterializationResult,
  build as configBuild,
  buildAll as configBuildAll,
  install as configInstall,
  materializeFromRefs as configMaterializeFromRefs,
  materializeTarget as configMaterializeTarget,
} from 'spaces-config'

import { harnessRegistry } from './harness/index.js'

// Claude CLI wrapper
export * from './claude/index.js'

// Harness adapters and registry
export * from './harness/index.js'

// Running (launching agents with plugins)
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

/**
 * Install options (with automatic harness adapter resolution)
 */
export type InstallOptions = Omit<ConfigInstallOptions, 'adapter'>

/**
 * Install targets from project manifest.
 *
 * This wraps the config package's install function and automatically
 * provides the harness adapter from the execution package's registry.
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  return configInstall({ ...options, adapter })
}

/**
 * Materialize a single target to asp_modules directory.
 *
 * This wraps the config package's materializeTarget function and automatically
 * provides the harness adapter from the execution package's registry.
 */
export async function materializeTarget(
  targetName: string,
  lock: LockFile,
  options: InstallOptions
): Promise<TargetMaterializationResult> {
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  return configMaterializeTarget(targetName, lock, { ...options, adapter })
}

// Re-export other install-related types
export type {
  InstallResult,
  TargetMaterializationResult,
  BuildResult,
  MaterializeFromRefsResult,
} from 'spaces-config'

/**
 * Materialize-from-refs options (with automatic harness adapter resolution)
 */
export type MaterializeFromRefsOptions = Omit<ConfigMaterializeFromRefsOptions, 'adapter'>

/**
 * Materialize spaces from explicit refs without reading asp-targets.toml.
 *
 * This wraps the config package's materializeFromRefs function and automatically
 * provides the harness adapter from the execution package's registry.
 */
export async function materializeFromRefs(
  options: MaterializeFromRefsOptions
): Promise<MaterializeFromRefsResult> {
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  return configMaterializeFromRefs({ ...options, adapter })
}

/**
 * Build options (with automatic harness adapter resolution)
 */
export type BuildOptions = Omit<ConfigBuildOptions, 'adapter'>

/**
 * Build (materialize) a target.
 *
 * This wraps the config package's build function and automatically
 * provides the harness adapter from the execution package's registry.
 */
export async function build(targetName: string, options: BuildOptions): Promise<BuildResult> {
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  return configBuild(targetName, { ...options, adapter })
}

/**
 * Build all targets.
 *
 * This wraps the config package's buildAll function and automatically
 * provides the harness adapter from the execution package's registry.
 */
export async function buildAll(options: BuildOptions): Promise<Map<string, BuildResult>> {
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  return configBuildAll({ ...options, adapter })
}
