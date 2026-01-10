/**
 * Claude launch orchestration (run command).
 *
 * WHY: Orchestrates the full run process:
 * - Resolve target
 * - Materialize to temporary directory
 * - Launch Claude with plugin directories
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type SpaceKey,
  type SpaceRefString,
  getEffectiveClaudeOptions,
  isSpaceRefString,
  parseSpaceRef,
  readSpaceToml,
} from '@agent-spaces/core'

import {
  type ClaudeInvocationResult,
  type ClaudeInvokeOptions,
  detectClaude,
  invokeClaude,
  spawnClaude,
} from '@agent-spaces/claude'

import { type LintContext, type LintWarning, type SpaceLintData, lint } from '@agent-spaces/lint'

import { composeMcpFromSpaces, materializeSpaces } from '@agent-spaces/materializer'

import { computeClosure, generateLockFileForTarget } from '@agent-spaces/resolver'

import { PathResolver, createSnapshot, ensureDir, getAspHome } from '@agent-spaces/store'

import { type BuildResult, build } from './build.js'
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
  /** Whether to clean up temp dir after run (default: true in non-interactive) */
  cleanup?: boolean | undefined
  /** Whether to print warnings before running (default: true) */
  printWarnings?: boolean | undefined
  /** Additional environment variables to pass to Claude subprocess */
  env?: Record<string, string> | undefined
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
  /** Temporary directory used (if not cleaned up) */
  tempDir?: string | undefined
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
 * Run a target with Claude.
 *
 * This:
 * 1. Detects Claude installation
 * 2. Builds (materializes) the target to a temp directory
 * 3. Launches Claude with plugin directories
 * 4. Optionally cleans up temp directory
 */
export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()

  // Detect Claude (throws ClaudeNotFoundError if not installed)
  await detectClaude()

  // Create temp directory for materialization
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, 'plugins')

  try {
    // Build (materialize) the target
    const buildResult = await build(targetName, {
      ...options,
      outputDir,
      clean: true,
      runLint: true,
    })

    // Print warnings if requested
    if (options.printWarnings !== false && buildResult.warnings.length > 0) {
      for (const warning of buildResult.warnings) {
        console.warn(`[${warning.code}] ${warning.message}`)
      }
    }

    // Load project manifest to get claude options
    const manifest = await loadProjectManifest(options.projectPath)
    const claudeOptions = getEffectiveClaudeOptions(manifest, targetName)

    // Build Claude invocation options
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs: buildResult.pluginDirs,
      mcpConfig: buildResult.mcpConfigPath,
      model: claudeOptions.model,
      permissionMode: claudeOptions.permission_mode,
      cwd: options.cwd ?? options.projectPath,
      args: [...(claudeOptions.args ?? []), ...(options.extraArgs ?? [])],
      env: options.env,
    }

    let exitCode: number
    let invocation: ClaudeInvocationResult | undefined

    if (options.interactive !== false) {
      // Interactive mode - spawn with inherited stdio
      const { proc } = await spawnClaude(invokeOptions)

      // Wait for process to exit
      exitCode = await proc.exited
    } else {
      // Non-interactive mode - capture output
      const promptArgs = options.prompt ? ['--print', options.prompt] : []
      invocation = await invokeClaude({
        ...invokeOptions,
        args: [...(invokeOptions.args ?? []), ...promptArgs],
        captureOutput: true,
      })
      exitCode = invocation.exitCode
    }

    // Cleanup if requested (default for non-interactive)
    const shouldCleanup = options.cleanup ?? !options.interactive
    if (shouldCleanup) {
      await rm(tempDir, { recursive: true, force: true })
    }

    return {
      build: buildResult,
      invocation,
      exitCode,
      tempDir: shouldCleanup ? undefined : tempDir,
    }
  } catch (error) {
    // Clean up on error
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
    throw error
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
}

/**
 * Run a space reference in global mode (without a project).
 *
 * This allows running `asp run space:my-space@stable` without being in a project.
 * The space is resolved from the registry, materialized, and run with Claude.
 */
export async function runGlobalSpace(
  spaceRefString: SpaceRefString,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })

  // Detect Claude
  await detectClaude()

  // Parse the space reference
  const _ref = parseSpaceRef(spaceRefString)

  // Get registry path
  const registryPath = options.registryPath ?? paths.repo

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

  // Create temp directory for materialization
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, 'plugins')
  await ensureDir(outputDir)

  try {
    // Build materialization inputs from closure
    const inputs = closure.loadOrder.map((key) => {
      const space = closure.spaces.get(key)!
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

    // Run lint checks
    let warnings: LintWarning[] = []
    if (options.printWarnings !== false) {
      const lintData: SpaceLintData[] = closure.loadOrder.map((key, i) => {
        const space = closure.spaces.get(key)!
        return {
          key,
          manifest: space.manifest,
          pluginPath: pluginDirs[i] ?? '',
        }
      })
      const lintContext: LintContext = { spaces: lintData }
      warnings = await lint(lintContext)

      for (const warning of warnings) {
        console.warn(`[${warning.code}] ${warning.message}`)
      }
    }

    // Build Claude invocation options
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      cwd: options.cwd ?? process.cwd(),
      args: options.extraArgs,
      env: options.env,
    }

    let exitCode: number
    let invocation: ClaudeInvocationResult | undefined

    if (options.interactive !== false) {
      // Interactive mode
      const { proc } = await spawnClaude(invokeOptions)
      exitCode = await proc.exited
    } else {
      // Non-interactive mode
      const promptArgs = options.prompt ? ['--print', options.prompt] : []
      invocation = await invokeClaude({
        ...invokeOptions,
        args: [...(invokeOptions.args ?? []), ...promptArgs],
        captureOutput: true,
      })
      exitCode = invocation.exitCode
    }

    // Cleanup
    const shouldCleanup = options.cleanup ?? !options.interactive
    if (shouldCleanup) {
      await rm(tempDir, { recursive: true, force: true })
    }

    return {
      build: {
        pluginDirs,
        mcpConfigPath,
        warnings,
        lock,
      },
      invocation,
      exitCode,
      tempDir: shouldCleanup ? undefined : tempDir,
    }
  } catch (error) {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
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

    // Run lint checks
    let warnings: LintWarning[] = []
    if (options.printWarnings !== false) {
      const lintData: SpaceLintData[] = [
        {
          key: spaceKey,
          manifest,
          pluginPath: pluginDirs[0] ?? '',
        },
      ]
      const lintContext: LintContext = { spaces: lintData }
      warnings = await lint(lintContext)

      for (const warning of warnings) {
        console.warn(`[${warning.code}] ${warning.message}`)
      }
    }

    // Build Claude invocation options
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      cwd: options.cwd ?? spacePath,
      args: options.extraArgs,
      env: options.env,
    }

    let exitCode: number
    let invocation: ClaudeInvocationResult | undefined

    if (options.interactive !== false) {
      const { proc } = await spawnClaude(invokeOptions)
      exitCode = await proc.exited
    } else {
      const promptArgs = options.prompt ? ['--print', options.prompt] : []
      invocation = await invokeClaude({
        ...invokeOptions,
        args: [...(invokeOptions.args ?? []), ...promptArgs],
        captureOutput: true,
      })
      exitCode = invocation.exitCode
    }

    // Cleanup
    const shouldCleanup = options.cleanup ?? !options.interactive
    if (shouldCleanup) {
      await rm(tempDir, { recursive: true, force: true })
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
        warnings,
        lock: syntheticLock,
      },
      invocation,
      exitCode,
      tempDir: shouldCleanup ? undefined : tempDir,
    }
  } catch (error) {
    try {
      await rm(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup errors
    }
    throw error
  }
}

/**
 * Check if a string is a space reference.
 */
export function isSpaceReference(value: string): value is SpaceRefString {
  return isSpaceRefString(value)
}
