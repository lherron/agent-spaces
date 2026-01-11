/**
 * Claude launch orchestration (run command).
 *
 * WHY: Orchestrates the full run process:
 * - Ensure target is installed (via asp_modules)
 * - Read materialized plugins from asp_modules
 * - Launch Claude with plugin directories
 */

import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  LOCK_FILENAME,
  type LockFile,
  type SpaceKey,
  type SpaceRefString,
  getEffectiveClaudeOptions,
  getTargetMcpConfigPath,
  getTargetPluginsPath,
  getTargetSettingsPath,
  isSpaceRefString,
  lockFileExists,
  parseSpaceRef,
  readLockJson,
  readSpaceToml,
  serializeLockJson,
  targetOutputExists,
} from '@agent-spaces/core'

import {
  type ClaudeInvocationResult,
  type ClaudeInvokeOptions,
  type SpawnClaudeOptions,
  detectClaude,
  getClaudeCommand,
  invokeClaude,
  spawnClaude,
} from '@agent-spaces/claude'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from '@agent-spaces/lint'

import {
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  materializeSpaces,
} from '@agent-spaces/materializer'

import { computeClosure, generateLockFileForTarget } from '@agent-spaces/resolver'

import { PathResolver, createSnapshot, ensureDir, getAspHome } from '@agent-spaces/store'

import type { BuildResult } from './build.js'
import { install } from './install.js'
import { type ResolveOptions, loadProjectManifest } from './resolve.js'

/**
 * Options for run operation.
 */
export interface RunOptions extends ResolveOptions {
  /** Working directory for Claude (default: projectPath) */
  cwd?: string | undefined
  /** Whether to run interactively (spawn stdio) vs capture output */
  interactive?: boolean | undefined
  /** Prompt to send (non-interactive mode) */
  prompt?: string | undefined
  /** Additional Claude CLI args */
  extraArgs?: string[] | undefined
  /** Whether to print warnings before running (default: true) */
  printWarnings?: boolean | undefined
  /** Additional environment variables to pass to Claude subprocess */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing Claude */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
  /** Path to settings JSON file or JSON string (--settings flag) */
  settings?: string | undefined
}

/**
 * Result of run operation.
 */
export interface RunResult {
  /** Build result (includes plugin dirs, warnings) */
  build: BuildResult
  /** Claude invocation result (if non-interactive) */
  invocation?: ClaudeInvocationResult | undefined
  /** Exit code from Claude */
  exitCode: number
  /** Full Claude command (for dry-run mode) */
  command?: string | undefined
}

/**
 * Create temporary directory for materialization.
 */
async function createTempDir(aspHome: string): Promise<string> {
  const paths = new PathResolver({ aspHome })
  await mkdir(paths.temp, { recursive: true })
  return mkdtemp(join(paths.temp, 'run-'))
}

/**
 * Resolve setting sources value for Claude invocation.
 *
 * @param settingSources - Value from options:
 *   - null: inherit all settings (don't pass --setting-sources)
 *   - undefined: default to isolated mode
 *   - '': isolated mode (pass --setting-sources "")
 *   - 'user,project': specific sources to inherit
 * @returns Value to pass to Claude, or undefined to omit the flag
 */
function resolveSettingSources(settingSources: string | null | undefined): string | undefined {
  // null means "inherit all" - don't pass the flag
  if (settingSources === null) {
    return undefined
  }
  // undefined means use default (isolated)
  if (settingSources === undefined) {
    return ''
  }
  // Otherwise pass the specified value
  return settingSources
}

// ============================================================================
// Claude Execution Helpers
// ============================================================================

/**
 * Result from executing Claude.
 */
interface ClaudeExecutionResult {
  exitCode: number
  invocation?: ClaudeInvocationResult | undefined
  command?: string | undefined
}

/**
 * Execute Claude in either interactive or non-interactive mode.
 */
async function executeClaude(
  invokeOptions: ClaudeInvokeOptions,
  options: {
    interactive?: boolean | undefined
    prompt?: string | undefined
    dryRun?: boolean | undefined
  }
): Promise<ClaudeExecutionResult> {
  // In dry-run mode, just get the command and return
  if (options.dryRun) {
    // Include prompt args in the command if present
    const promptArgs = options.prompt ? ['--print', options.prompt] : []
    const fullOptions = {
      ...invokeOptions,
      args: [...(invokeOptions.args ?? []), ...promptArgs],
    }
    const command = await getClaudeCommand(fullOptions)
    return { exitCode: 0, command }
  }

  if (options.interactive !== false) {
    // Interactive mode - spawn with inherited stdio
    const spawnOptions: SpawnClaudeOptions = { ...invokeOptions, inheritStdio: true }
    const { proc } = await spawnClaude(spawnOptions)
    const exitCode = await proc.exited
    return { exitCode }
  }

  // Non-interactive mode - capture output
  const promptArgs = options.prompt ? ['--print', options.prompt] : []
  const invocation = await invokeClaude({
    ...invokeOptions,
    args: [...(invokeOptions.args ?? []), ...promptArgs],
    captureOutput: true,
  })
  return { exitCode: invocation.exitCode, invocation }
}

/**
 * Cleanup a temporary directory, ignoring errors.
 */
async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Print lint warnings to console if requested.
 * Returns true if there are any errors (severity: 'error').
 */
function printWarnings(warnings: LintWarning[], shouldPrint: boolean): boolean {
  let hasErrors = false
  if (!shouldPrint || warnings.length === 0) return hasErrors

  for (const warning of warnings) {
    if (warning.severity === 'error') {
      hasErrors = true
      console.error(`[${warning.code}] Error: ${warning.message}`)
    } else {
      console.warn(`[${warning.code}] ${warning.message}`)
    }
  }
  return hasErrors
}

/**
 * Persist a lock file to the global lock file.
 * Merges with existing global lock if present, adding/updating entries.
 *
 * WHY: Global mode runs (asp run space:id@selector) need to persist pins
 * to maintain "locked-by-default" behavior even for ad-hoc runs.
 */
async function persistGlobalLock(newLock: LockFile, globalLockPath: string): Promise<void> {
  let existingLock: LockFile | undefined

  // Load existing global lock if it exists
  if (await lockFileExists(globalLockPath)) {
    try {
      existingLock = await readLockJson(globalLockPath)
    } catch {
      // If corrupt, we'll overwrite with new lock
    }
  }

  // Merge with existing lock or use new lock as-is
  const mergedLock: LockFile = existingLock
    ? {
        lockfileVersion: newLock.lockfileVersion,
        resolverVersion: newLock.resolverVersion,
        generatedAt: newLock.generatedAt,
        registry: newLock.registry,
        spaces: { ...existingLock.spaces, ...newLock.spaces },
        targets: { ...existingLock.targets, ...newLock.targets },
      }
    : newLock

  // Write merged lock file
  await writeFile(globalLockPath, serializeLockJson(mergedLock), 'utf-8')
}

/**
 * Get plugin directories from asp_modules/<target>/plugins/.
 * Returns directories sorted alphabetically to respect numeric prefixes (e.g., "000-base", "001-frontend").
 */
async function getPluginDirsFromAspModules(
  projectPath: string,
  targetName: string
): Promise<string[]> {
  const pluginsPath = getTargetPluginsPath(projectPath, targetName)
  const entries = await readdir(pluginsPath, { withFileTypes: true })

  const pluginDirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      pluginDirs.push(join(pluginsPath, entry.name))
    }
  }

  // Sort alphabetically to respect numeric prefixes that preserve load order
  return pluginDirs.sort()
}

/**
 * Run a target with Claude.
 *
 * This:
 * 1. Detects Claude installation
 * 2. Ensures target is installed (asp_modules/<target>/ exists)
 * 3. Reads plugin directories from asp_modules
 * 4. Launches Claude with plugin directories
 */
export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  // Detect Claude (throws ClaudeNotFoundError if not installed)
  await detectClaude()

  // Check if target is installed, if not run install
  if (!(await targetOutputExists(options.projectPath, targetName))) {
    await install({
      ...options,
      targets: [targetName],
    })
  }

  // Get paths from asp_modules
  const pluginDirs = await getPluginDirsFromAspModules(options.projectPath, targetName)
  const mcpConfigPath = getTargetMcpConfigPath(options.projectPath, targetName)
  const settingsPath = getTargetSettingsPath(options.projectPath, targetName)

  // Check if MCP config exists and has content
  let mcpConfig: string | undefined
  try {
    const mcpStats = await stat(mcpConfigPath)
    if (mcpStats.size > 2) {
      // More than just "{}"
      mcpConfig = mcpConfigPath
    }
  } catch {
    // MCP config doesn't exist, that's fine
  }

  // Load lock file to get warnings and metadata
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lock = await readLockJson(lockPath)

  // Run lint checks
  // TODO: Consider caching lint results in asp_modules
  const warnings: LintWarning[] = []

  // Print warnings if requested, halt on errors
  const hasErrors = printWarnings(warnings, options.printWarnings !== false)
  if (hasErrors) {
    throw new Error('Lint errors found - aborting')
  }

  // Load project manifest to get claude options
  const manifest = await loadProjectManifest(options.projectPath)
  const claudeOptions = getEffectiveClaudeOptions(manifest, targetName)

  // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
  const settingSources = resolveSettingSources(options.settingSources)

  // Build Claude invocation options
  // Use settings from options if provided, otherwise use composed settings from asp_modules
  const invokeOptions: ClaudeInvokeOptions = {
    pluginDirs,
    mcpConfig,
    model: claudeOptions.model,
    permissionMode: claudeOptions.permission_mode,
    settingSources,
    settings: options.settings ?? settingsPath,
    cwd: options.cwd ?? options.projectPath,
    args: [...(claudeOptions.args ?? []), ...(options.extraArgs ?? [])],
    env: options.env,
  }

  // Execute Claude
  const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)

  // Build a BuildResult-compatible object for the return value
  const buildResult: BuildResult = {
    pluginDirs,
    mcpConfigPath: mcpConfig,
    settingsPath,
    warnings,
    lock,
  }

  return {
    build: buildResult,
    invocation,
    exitCode,
    command,
  }
}

/**
 * Run with a specific prompt (non-interactive).
 */
export async function runWithPrompt(
  targetName: string,
  prompt: string,
  options: Omit<RunOptions, 'prompt' | 'interactive'>
): Promise<RunResult> {
  return run(targetName, {
    ...options,
    prompt,
    interactive: false,
  })
}

/**
 * Run interactively.
 */
export async function runInteractive(
  targetName: string,
  options: Omit<RunOptions, 'interactive'>
): Promise<RunResult> {
  return run(targetName, {
    ...options,
    interactive: true,
  })
}

// ============================================================================
// Global Mode (running without a project)
// ============================================================================

/**
 * Options for global mode run operations.
 */
export interface GlobalRunOptions {
  /** Override ASP_HOME location */
  aspHome?: string | undefined
  /** Registry path override */
  registryPath?: string | undefined
  /** Working directory for Claude */
  cwd?: string | undefined
  /** Whether to run interactively (default: true) */
  interactive?: boolean | undefined
  /** Prompt for non-interactive mode */
  prompt?: string | undefined
  /** Additional Claude CLI args */
  extraArgs?: string[] | undefined
  /** Whether to clean up temp dir after run */
  cleanup?: boolean | undefined
  /** Whether to print warnings */
  printWarnings?: boolean | undefined
  /** Additional environment variables */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing Claude */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
  /** Path to settings JSON file or JSON string (--settings flag) */
  settings?: string | undefined
}

/**
 * Run a space reference in global mode (without a project).
 *
 * This allows running `asp run space:my-space@stable` without being in a project.
 * The space is resolved from the registry, materialized, and run with Claude.
 *
 * For @dev selector, runs directly from the filesystem (working directory).
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Global space run orchestrates multiple steps
export async function runGlobalSpace(
  spaceRefString: SpaceRefString,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })

  // Detect Claude
  await detectClaude()

  // Parse the space reference
  const ref = parseSpaceRef(spaceRefString)

  // Get registry path
  const registryPath = options.registryPath ?? paths.repo

  // Handle @dev selector - run directly from filesystem
  if (ref.selector.kind === 'dev') {
    const spacePath = join(registryPath, 'spaces', ref.id)
    return runLocalSpace(spacePath, options)
  }

  // Compute closure for this single space (with its dependencies)
  const closure = await computeClosure([spaceRefString], { cwd: registryPath })

  // Create snapshots for all spaces in the closure
  for (const spaceKey of closure.loadOrder) {
    const space = closure.spaces.get(spaceKey)
    if (!space) continue
    await createSnapshot(space.id, space.commit, { paths, cwd: registryPath })
  }

  // Generate a synthetic lock file for materialization
  const lock = await generateLockFileForTarget('_global', [spaceRefString], closure, {
    cwd: registryPath,
    registry: { type: 'git', url: registryPath },
  })

  // Persist to global lock file (merge with existing if present)
  await persistGlobalLock(lock, paths.globalLock)

  // Create temp directory for materialization
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, 'plugins')
  await ensureDir(outputDir)

  try {
    // Build materialization inputs from closure
    const inputs = closure.loadOrder.map((key) => {
      const space = closure.spaces.get(key)
      if (!space) throw new Error(`Space not found in closure: ${key}`)
      const lockEntry = lock.spaces[key]
      return {
        manifest: {
          schema: 1 as const,
          id: space.id,
          plugin: lockEntry?.plugin ?? { name: space.manifest.plugin?.name ?? space.id },
        },
        snapshotPath: paths.snapshot(lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`),
        spaceKey: key,
        integrity: lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`,
      }
    })

    // Materialize all spaces
    const materializeResults = await materializeSpaces(inputs, { paths })
    const pluginDirs = materializeResults.map((r) => r.pluginPath)

    // Compose MCP configuration
    let mcpConfigPath: string | undefined
    const mcpOutputPath = join(outputDir, 'mcp.json')
    const spacesDirs = materializeResults.map((r) => ({
      spaceId: r.spaceKey.split('@')[0] ?? r.spaceKey,
      dir: r.pluginPath,
    }))
    const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
    if (Object.keys(mcpResult.config.mcpServers).length > 0) {
      mcpConfigPath = mcpOutputPath
    }

    // Compose settings from all spaces in the closure
    const settingsOutputPath = join(outputDir, 'settings.json')
    const settingsInputs: SettingsInput[] = []
    for (const key of closure.loadOrder) {
      const space = closure.spaces.get(key)
      if (space?.manifest.settings) {
        settingsInputs.push({
          spaceId: space.id as string,
          settings: space.manifest.settings,
        })
      }
    }

    await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
    const settingsPath = settingsOutputPath

    // Run lint checks
    let warnings: LintWarning[] = []
    const lintData: SpaceLintData[] = closure.loadOrder.map((key, i) => {
      const space = closure.spaces.get(key)
      if (!space) throw new Error(`Space not found in closure: ${key}`)
      return {
        key,
        manifest: space.manifest,
        pluginPath: pluginDirs[i] ?? '',
      }
    })
    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
    const hasGlobalErrors = printWarnings(warnings, options.printWarnings !== false)
    if (hasGlobalErrors) {
      throw new Error('Lint errors found - aborting')
    }

    // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
    const settingSources = resolveSettingSources(options.settingSources)

    // Build Claude invocation options
    // Use settings from options if provided, otherwise use composed settings
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      settingSources,
      settings: options.settings ?? settingsPath,
      cwd: options.cwd ?? process.cwd(),
      args: options.extraArgs,
      env: options.env,
    }

    // Execute Claude
    const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)

    // Cleanup (always for dry-run)
    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

    return {
      build: {
        pluginDirs,
        mcpConfigPath,
        settingsPath,
        warnings,
        lock,
      },
      invocation,
      exitCode,
      command,
    }
  } catch (error) {
    await cleanupTempDir(tempDir)
    throw error
  }
}

/**
 * Run a local space directory in dev mode (without a project).
 *
 * This allows running `asp run ./my-space` for local development.
 * The space is read directly from the filesystem.
 */
export async function runLocalSpace(
  spacePath: string,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })

  // Detect Claude
  await detectClaude()

  // Read the space manifest
  const manifestPath = join(spacePath, 'space.toml')
  const manifest = await readSpaceToml(manifestPath)

  // Create temp directory
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, 'plugins')
  await ensureDir(outputDir)

  try {
    // For local dev mode, we materialize directly from the source path
    // Create a synthetic space key
    const spaceKey = `${manifest.id}@local` as SpaceKey

    // Build input for materialization
    const inputs = [
      {
        manifest,
        snapshotPath: spacePath, // Use local path directly
        spaceKey,
        integrity: 'sha256:local' as `sha256:${string}`,
      },
    ]

    // Materialize (this will copy from the local path)
    const materializeResults = await materializeSpaces(inputs, { paths })
    const pluginDirs = materializeResults.map((r) => r.pluginPath)

    // Compose MCP configuration
    let mcpConfigPath: string | undefined
    const mcpOutputPath = join(outputDir, 'mcp.json')
    const spacesDirs = materializeResults.map((r) => ({
      spaceId: manifest.id,
      dir: r.pluginPath,
    }))
    const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
    if (Object.keys(mcpResult.config.mcpServers).length > 0) {
      mcpConfigPath = mcpOutputPath
    }

    // Compose settings from the local space
    const settingsOutputPath = join(outputDir, 'settings.json')
    const settingsInputs: SettingsInput[] = manifest.settings
      ? [{ spaceId: manifest.id, settings: manifest.settings }]
      : []
    await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
    const settingsPath = settingsOutputPath

    // Run lint checks
    let warnings: LintWarning[] = []
    const lintData: SpaceLintData[] = [
      {
        key: spaceKey,
        manifest,
        pluginPath: pluginDirs[0] ?? '',
      },
    ]
    const lintContext: LintContext = { spaces: lintData }
    warnings = await lint(lintContext)
    const hasLocalErrors = printWarnings(warnings, options.printWarnings !== false)
    if (hasLocalErrors) {
      throw new Error('Lint errors found - aborting')
    }

    // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
    const settingSources = resolveSettingSources(options.settingSources)

    // Build Claude invocation options
    // Use settings from options if provided, otherwise use composed settings
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      settingSources,
      settings: options.settings ?? settingsPath,
      cwd: options.cwd ?? spacePath,
      args: options.extraArgs,
      env: options.env,
    }

    // Execute Claude
    const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)

    // Cleanup (always for dry-run)
    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

    // Create a synthetic lock for the result
    const syntheticLock = {
      lockfileVersion: 1 as const,
      resolverVersion: 1 as const,
      generatedAt: new Date().toISOString(),
      registry: { type: 'git' as const, url: 'local' },
      spaces: {},
      targets: {},
    }

    return {
      build: {
        pluginDirs,
        mcpConfigPath,
        settingsPath,
        warnings,
        lock: syntheticLock,
      },
      invocation,
      exitCode,
      command,
    }
  } catch (error) {
    await cleanupTempDir(tempDir)
    throw error
  }
}

/**
 * Check if a string is a space reference.
 */
export function isSpaceReference(value: string): value is SpaceRefString {
  return isSpaceRefString(value)
}
