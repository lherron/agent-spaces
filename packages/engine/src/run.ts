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

import { getEffectiveClaudeOptions } from '@agent-spaces/core'

import {
  type ClaudeInvocationResult,
  type ClaudeInvokeOptions,
  detectClaude,
  invokeClaude,
  spawnClaude,
} from '@agent-spaces/claude'

import { PathResolver, getAspHome } from '@agent-spaces/store'

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
