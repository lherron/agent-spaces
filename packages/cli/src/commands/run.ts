/**
 * Run command - Launch Claude with composed plugin directories.
 *
 * WHY: This is the primary command users interact with. It resolves
 * a target, materializes plugins to a temp directory, and launches
 * Claude with all the plugin directories.
 *
 * Supports three modes:
 * 1. Project mode: Run a target from asp-targets.toml
 * 2. Global mode: Run a space reference (space:id@selector) without a project
 * 3. Dev mode: Run a local space directory (./path/to/space)
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import {
  type RunResult,
  isSpaceReference,
  runGlobalSpace,
  runInteractive,
  runLocalSpace,
  runWithPrompt,
} from '@agent-spaces/engine'

import { handleCliError, logInvocationOutput } from '../helpers.js'
import { findProjectRoot } from '../index.js'

/**
 * Run modes for the command.
 */
type RunMode = 'project' | 'global' | 'dev' | 'invalid'

/**
 * CLI options for run command.
 */
interface RunOptions {
  project?: string
  aspHome?: string
  registry?: string
  warnings?: boolean
  interactive?: boolean
  extraArgs?: string[]
}

/**
 * Check if path is a local space directory.
 */
async function isLocalSpacePath(targetPath: string): Promise<boolean> {
  try {
    const stats = await stat(targetPath)
    if (!stats.isDirectory()) return false

    await stat(resolve(targetPath, 'space.toml'))
    return true
  } catch {
    return false
  }
}

/**
 * Detect which run mode to use based on project path and target.
 */
async function detectRunMode(projectPath: string | null, target: string): Promise<RunMode> {
  if (projectPath) {
    return 'project'
  }

  if (isSpaceReference(target)) {
    return 'global'
  }

  const targetPath = resolve(target)
  if (await isLocalSpacePath(targetPath)) {
    return 'dev'
  }

  return 'invalid'
}

/**
 * Run in project mode (target from asp-targets.toml).
 */
async function runProjectMode(
  target: string,
  prompt: string | undefined,
  projectPath: string,
  options: RunOptions
): Promise<RunResult> {
  const runOptions = {
    projectPath,
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
  }

  if (prompt) {
    console.log(chalk.blue(`Running target "${target}" with prompt...`))
    const result = await runWithPrompt(target, prompt, runOptions)
    logInvocationOutput(result.invocation)
    return result
  }

  if (options.interactive === false) {
    console.error(chalk.red('Error: --no-interactive requires a prompt'))
    process.exit(1)
  }

  console.log(chalk.blue(`Running target "${target}" interactively...`))
  console.log(chalk.gray('Press Ctrl+C to exit'))
  console.log('')
  return runInteractive(target, runOptions)
}

/**
 * Run in global mode (space reference from registry).
 * Note: target is validated as a space reference by isSpaceReference() before this is called.
 */
async function runGlobalMode(
  target: string,
  prompt: string | undefined,
  options: RunOptions
): Promise<RunResult> {
  console.log(chalk.blue(`Running space "${target}" in global mode...`))

  const globalOptions = {
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
    interactive: options.interactive !== false,
    prompt,
  }

  // target is validated by isSpaceReference() in detectRunMode before this function is called
  const result = await runGlobalSpace(target as `space:${string}@${string}`, globalOptions)
  logInvocationOutput(result.invocation)
  return result
}

/**
 * Run in dev mode (local space directory).
 */
async function runDevMode(
  target: string,
  prompt: string | undefined,
  options: RunOptions
): Promise<RunResult> {
  const targetPath = resolve(target)
  console.log(chalk.blue(`Running local space "${target}" in dev mode...`))

  const devOptions = {
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
    interactive: options.interactive !== false,
    prompt,
  }

  const result = await runLocalSpace(targetPath, devOptions)
  logInvocationOutput(result.invocation)
  return result
}

/**
 * Show usage help when run mode is invalid.
 */
function showInvalidModeHelp(): never {
  console.error(
    chalk.red('Error: No asp-targets.toml found and target is not a valid space reference or path')
  )
  console.error(chalk.gray(''))
  console.error(chalk.gray('Usage:'))
  console.error(chalk.gray('  In a project: asp run <target-name>'))
  console.error(chalk.gray('  Global mode:  asp run space:my-space@stable'))
  console.error(chalk.gray('  Dev mode:     asp run ./path/to/space'))
  process.exit(1)
}

/**
 * Register the run command.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run Claude with a target, space reference, or filesystem path')
    .argument('<target>', 'Target name from asp-targets.toml, space:id@selector, or path')
    .argument('[prompt]', 'Optional initial prompt (runs non-interactively)')
    .option('--no-interactive', 'Run non-interactively (requires prompt)')
    .option('--no-warnings', 'Suppress lint warnings')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--extra-args <args...>', 'Additional Claude CLI arguments')
    .action(async (target: string, prompt: string | undefined, options: RunOptions) => {
      const projectPath = options.project ?? (await findProjectRoot())

      try {
        const mode = await detectRunMode(projectPath, target)
        let result: RunResult

        switch (mode) {
          case 'project':
            // projectPath is guaranteed non-null when mode is 'project' (checked in detectRunMode)
            result = await runProjectMode(target, prompt, projectPath as string, options)
            break
          case 'global':
            result = await runGlobalMode(target, prompt, options)
            break
          case 'dev':
            result = await runDevMode(target, prompt, options)
            break
          case 'invalid':
            showInvalidModeHelp()
        }

        process.exit(result.exitCode)
      } catch (error) {
        handleCliError(error)
      }
    })
}
