/**
 * Run command - Launch Claude with composed plugin directories.
 *
 * WHY: This is the primary command users interact with. It ensures
 * the target is installed (materializing to asp_modules/ if needed)
 * and launches Claude with the plugin directories.
 *
 * Supports three modes:
 * 1. Project mode: Run a target from asp-targets.toml (uses asp_modules/)
 * 2. Global mode: Run a space reference (space:id@selector) without a project
 * 3. Dev mode: Run a local space directory (./path/to/space)
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import { parseSpaceRef } from 'spaces-config'
import {
  type HarnessId,
  type RunResult,
  harnessRegistry,
  isHarnessId,
  isSpaceReference,
  run,
  runGlobalSpace,
  runLocalSpace,
} from 'spaces-execution'

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
  dryRun?: boolean
  printCommand?: boolean
  refresh?: boolean
  yolo?: boolean
  debug?: boolean
  permissionMode?: string
  inheritAll?: boolean
  inheritProject?: boolean
  inheritUser?: boolean
  inheritLocal?: boolean
  settings?: string
  harness?: HarnessId
  model?: string
  resume?: string | boolean
}

/**
 * Build setting sources value from inherit flags.
 *
 * Returns:
 * - null: inherit all settings (--inherit-all)
 * - string: specific sources to inherit ('user,project')
 * - undefined: use default behavior (isolated mode)
 */
function buildSettingSources(options: RunOptions): string | null | undefined {
  // --inherit-all means use all sources (don't pass --setting-sources at all)
  if (options.inheritAll) {
    return null
  }

  const sources: string[] = []
  if (options.inheritProject) sources.push('project')
  if (options.inheritUser) sources.push('user')
  if (options.inheritLocal) sources.push('local')

  // If any inherit flags specified, return the combined string
  if (sources.length > 0) {
    return sources.join(',')
  }

  // Default: isolated mode (undefined means "use default" which is isolated)
  return undefined
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
 *
 * Priority:
 * 1. Space reference (space:id@selector) → global mode
 * 2. Local path with space.toml → dev mode
 * 3. Project found → project mode (target is a target name)
 * 4. Otherwise → invalid
 */
async function detectRunMode(projectPath: string | null, target: string): Promise<RunMode> {
  // Space references always use global mode
  if (isSpaceReference(target)) {
    return 'global'
  }

  // Local paths with space.toml use dev mode
  const targetPath = resolve(target)
  if (await isLocalSpacePath(targetPath)) {
    return 'dev'
  }

  // If in a project, treat target as a target name
  if (projectPath) {
    return 'project'
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
  const settingSources = buildSettingSources(options)
  const runOptions = {
    projectPath,
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
    dryRun: options.dryRun,
    refresh: options.refresh,
    yolo: options.yolo,
    debug: options.debug,
    permissionMode: options.permissionMode,
    settingSources,
    settings: options.settings,
    harness: options.harness,
    model: options.model,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    resume: options.resume,
  }

  if (options.dryRun) {
    if (!options.printCommand) {
      console.log(chalk.yellow('Dry run - building and showing command...'))
    }
    const result = await run(target, {
      ...runOptions,
      dryRun: true,
      prompt,
      interactive: options.interactive,
    })
    return result
  }

  const interactive = options.interactive !== false
  if (interactive) {
    console.log(chalk.blue(`Running target "${target}" interactively...`))
    console.log(chalk.gray('Press Ctrl+C to exit'))
  } else {
    console.log(chalk.blue(`Running target "${target}" non-interactively...`))
  }
  console.log('')

  const result = await run(target, {
    ...runOptions,
    prompt,
    interactive,
  })
  logInvocationOutput(result.invocation)
  return result
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
  // Check if selector was defaulted to dev and warn the user
  const spaceRef = parseSpaceRef(target)
  const aspHome = options.aspHome ?? process.env['ASP_HOME'] ?? `${process.env['HOME']}/.asp`
  const registryPath = options.registry ?? `${aspHome}/repo`
  const spacePath = `${registryPath}/spaces/${spaceRef.id}`

  if (spaceRef.defaultedToDev && !options.printCommand) {
    console.log(
      chalk.yellow(
        `Warning: No selector specified for "${spaceRef.id}", using @dev (working directory)`
      )
    )
    console.log(chalk.gray(`  Path: ${spacePath}`))
    console.log(chalk.gray(`  For a stable version, use: space:${spaceRef.id}@stable`))
    console.log(chalk.gray(`  For latest commit, use: space:${spaceRef.id}@HEAD`))
    console.log('')
  }

  if (options.dryRun) {
    if (!options.printCommand) {
      console.log(chalk.yellow('Dry run - building and showing command...'))
    }
  } else {
    console.log(chalk.blue(`Running space "${target}" in global mode...`))
  }

  const settingSources = buildSettingSources(options)
  const globalOptions = {
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
    interactive: options.interactive !== false,
    prompt,
    dryRun: options.dryRun,
    refresh: options.refresh,
    yolo: options.yolo,
    debug: options.debug,
    permissionMode: options.permissionMode,
    settingSources,
    settings: options.settings,
    harness: options.harness,
    model: options.model,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    resume: options.resume,
  }

  // target is validated by isSpaceReference() in detectRunMode before this function is called
  const result = await runGlobalSpace(target as `space:${string}@${string}`, globalOptions)
  if (!options.dryRun) {
    logInvocationOutput(result.invocation)
  }
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
  if (options.dryRun) {
    if (!options.printCommand) {
      console.log(chalk.yellow('Dry run - building and showing command...'))
    }
  } else {
    console.log(chalk.blue(`Running local space "${target}" in dev mode...`))
  }

  const settingSources = buildSettingSources(options)
  const devOptions = {
    aspHome: options.aspHome,
    registryPath: options.registry,
    printWarnings: options.warnings !== false,
    extraArgs: options.extraArgs,
    interactive: options.interactive !== false,
    prompt,
    dryRun: options.dryRun,
    refresh: options.refresh,
    yolo: options.yolo,
    debug: options.debug,
    permissionMode: options.permissionMode,
    settingSources,
    settings: options.settings,
    harness: options.harness,
    model: options.model,
    inheritProject: options.inheritProject,
    resume: options.resume,
    inheritUser: options.inheritUser,
  }

  const result = await runLocalSpace(targetPath, devOptions)
  if (!options.dryRun) {
    logInvocationOutput(result.invocation)
  }
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
  console.error(
    chalk.gray('  Global mode:  asp run space:my-space         (uses @dev - working dir)')
  )
  console.error(chalk.gray('                asp run space:my-space@HEAD    (uses latest commit)'))
  console.error(chalk.gray('                asp run space:my-space@stable  (uses dist-tag)'))
  console.error(chalk.gray('  Dev mode:     asp run ./path/to/space'))
  process.exit(1)
}

/**
 * Validate harness option and return the harness ID.
 */
function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    console.error(chalk.red(`Error: Unknown harness "${harnessId}"`))
    console.error(chalk.gray(''))
    console.error(chalk.gray('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.error(chalk.gray(`  - ${adapter.id}`))
    }
    process.exit(1)
  }

  return harnessId
}

/**
 * Register the run command.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run a coding agent with a target, space reference, or filesystem path')
    .argument('<target>', 'Target name from asp-targets.toml, space:id@selector, or path')
    .argument('[prompt]', 'Optional initial prompt')
    .option(
      '--harness <id>',
      'Coding agent harness to use (default: claude, e.g., claude-agent-sdk, codex, pi, pi-sdk)'
    )
    .option('--model <model>', 'Model override (pi-sdk expects provider:model)')
    .option('--permission-mode <mode>', 'Claude permission mode (--permission-mode)')
    .option('--no-interactive', 'Run non-interactively')
    .option('--no-warnings', 'Suppress lint warnings')
    .option('--dry-run', 'Print the harness command without executing')
    .option('--print-command', 'Output only the command (for piping/scripting)')
    .option('--no-refresh', 'Skip refresh and use cached asp_modules')
    .option('--yolo', 'Skip all permission prompts (--dangerously-skip-permissions)')
    .option('--debug', 'Enable Claude hook debugging (--debug hooks)')
    .option('--inherit-all', 'Inherit all harness settings (user, project, local)')
    .option('--inherit-project', 'Inherit project-level settings')
    .option('--inherit-user', 'Inherit user-level settings')
    .option('--inherit-local', 'Inherit local settings')
    .option('--settings <file-or-json>', 'Path to settings JSON file or JSON string')
    .option('--resume [session-id]', 'Resume a previous session (opens picker if no ID provided)')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--extra-args <args...>', 'Additional harness CLI arguments')
    .action(async (target: string, prompt: string | undefined, options: RunOptions) => {
      // Validate harness option
      const _harness = validateHarness(options.harness)
      options.harness = _harness
      const projectPath = options.project ?? (await findProjectRoot())

      // --print-command implies dry-run but with silent output
      if (options.printCommand) {
        options.dryRun = true
      }

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

        // --print-command: output only the command (for scripting)
        if (options.printCommand && result.command) {
          console.log(result.command)
          process.exit(0)
        }

        // In dry-run mode, print the command with formatting
        if (options.dryRun && result.command) {
          console.log('')
          console.log(chalk.cyan('Command:'))
          console.log(result.command)
        }

        process.exit(result.exitCode)
      } catch (error) {
        handleCliError(error)
      }
    })
}
