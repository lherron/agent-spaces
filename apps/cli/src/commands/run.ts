/**
 * Run command - Launch Claude with composed plugin directories.
 *
 * WHY: This is the primary command users interact with. It ensures
 * the target is installed (materializing under ASP_HOME if needed)
 * and launches Claude with the plugin directories.
 *
 * Supports three modes:
 * 1. Project mode: Run a target from asp-targets.toml (uses ASP_HOME project bundles)
 * 2. Global mode: Run a space reference (space:id@selector) without a project
 * 3. Dev mode: Run a local space directory (./path/to/space)
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

import { createCompileRuntimeFn } from 'agent-spaces'
import chalk from 'chalk'
import type { Command } from 'commander'

import {
  TARGETS_FILENAME,
  getAgentsRoot,
  getAspHome,
  getRegistryPath,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  parseSpaceRef,
  parseTargetsToml,
  resolveAgentPlacementPaths,
} from 'spaces-config'
import {
  type HarnessId,
  type RunResult,
  isSpaceReference,
  run,
  runGlobalSpace,
  runLocalSpace,
} from 'spaces-execution'

import { compilerRuntime } from '../compiler-runtime.js'
import { validateOptionalHarness } from '../harness-validator.js'
import { exitWithAspError, logInvocationOutput } from '../helpers.js'
import { findProjectRoot } from '../lib.js'
import { displayRunResultPrompts } from '../prompt-display.js'
import { type ResolvedRunTarget, resolveRunTarget } from '../scope-target-resolver.js'
import { buildSettingSources } from '../settings-helper.js'

/**
 * Run modes for the command.
 */
type RunMode = 'project' | 'global' | 'dev' | 'invalid'

interface DirectAgentHarnessPlan {
  kind: 'agent-harness'
  executable: string
  semanticCommand: string
  args: string[]
}

/**
 * CLI options for run command.
 */
interface RunOptions {
  project?: string
  aspHome?: string
  registry?: string
  interactive?: boolean
  extraArgs?: string[]
  dryRun?: boolean
  printCommand?: boolean
  refresh?: boolean
  yolo?: boolean
  debug?: boolean
  permissionMode?: string
  modelReasoningEffort?: string
  inheritAll?: boolean
  inheritProject?: boolean
  inheritUser?: boolean
  inheritLocal?: boolean
  settings?: string
  harness?: HarnessId | undefined
  model?: string
  resume?: string | boolean
  remoteControl?: boolean
  namePrefix?: string
  pagePrompts?: boolean
}

/**
 * Build the run-option fields shared by every run mode.
 *
 * WHY: the project/global/dev literals were ~25-field copies that drifted
 * easily. Each mode now spreads this common shape and adds only its
 * mode-specific keys (projectPath/projectId/taskId, interactive, prompt).
 */
function buildCommonRunOptions(options: RunOptions) {
  return {
    aspHome: options.aspHome,
    registryPath: options.registry,
    extraArgs: options.extraArgs,
    dryRun: options.dryRun,
    refresh: options.refresh,
    yolo: options.yolo,
    debug: options.debug,
    permissionMode: options.permissionMode,
    settingSources: buildSettingSources(options),
    settings: options.settings,
    harness: options.harness,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    continuationKey: options.resume,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.namePrefix,
    pagePrompts: options.pagePrompts,
    compileRuntime: createCompileRuntimeFn(options.aspHome, compilerRuntime),
  }
}

/**
 * Resolve a direct foreground plan before any adapter, bundle, or compiler work.
 * `agent-harness` owns its Pi resource loader and therefore cannot be lowered
 * through the external-harness execution pipeline.
 */
function planDirectAgentHarness(
  target: ResolvedRunTarget,
  projectPath: string,
  prompt: string | undefined,
  options: RunOptions
): DirectAgentHarnessPlan | undefined {
  const projectId = target.projectId ?? projectPath.split('/').filter(Boolean).at(-1)
  if (projectId === undefined) throw new Error('agent-harness requires a resolved project identity')
  const paths = resolveAgentPlacementPaths({
    agentId: target.targetName,
    projectId,
    projectRoot: projectPath,
    cwd: process.cwd(),
    aspHome: options.aspHome,
    env: process.env,
  })
  const explicitDirect = options.harness === 'agent-harness'
  if (paths.agentRoot === undefined) {
    if (explicitDirect) throwDirectAgentProfileError(target.displayTarget)
    return undefined
  }

  const profilePath = join(paths.agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    if (explicitDirect) throwDirectAgentProfileError(target.displayTarget)
    return undefined
  }
  const profile = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath)
  const targetDefinition = loadProjectTarget(projectPath, target.targetName)
  const effectiveHarness =
    options.harness ?? mergeAgentWithProjectTarget(profile, targetDefinition, 'task').harness
  if (effectiveHarness !== 'agent-harness') return undefined

  rejectDirectCompilerOptions(options)
  if (options.interactive === false && prompt === undefined) {
    throw new Error(
      'agent-harness print mode requires an initial prompt (--no-interactive <agent> <prompt>)'
    )
  }

  const mode = options.interactive === false ? 'print' : 'tui'
  const args = [
    mode,
    '--agent-id',
    target.targetName,
    '--project-id',
    projectId,
    '--agent-root',
    paths.agentRoot,
    '--project-root',
    projectPath,
    '--cwd',
    process.cwd(),
    '--asp-home',
    options.aspHome ?? getAspHome(),
  ]
  if (options.model !== undefined) args.push('--model', options.model)
  if (options.modelReasoningEffort !== undefined) {
    args.push('--reasoning-effort', options.modelReasoningEffort)
  }
  if (options.resume !== undefined) {
    args.push('--resume')
    if (typeof options.resume === 'string') args.push(options.resume)
  }
  if (prompt !== undefined) args.push(prompt)
  return {
    kind: 'agent-harness',
    executable: resolveAgentHarnessEntrypoint(),
    semanticCommand: formatShellCommand('agent-harness', args),
    args,
  }
}

function loadProjectTarget(projectPath: string, targetName: string) {
  const targetsPath = join(projectPath, TARGETS_FILENAME)
  if (!existsSync(targetsPath)) return undefined
  return parseTargetsToml(readFileSync(targetsPath, 'utf8'), targetsPath).targets[targetName]
}

function throwDirectAgentProfileError(target: string): never {
  throw new Error(
    `agent-harness requires a validated agent profile for target "${target}"; global, dev, and arbitrary project-space targets are unsupported`
  )
}

function rejectDirectCompilerOptions(options: RunOptions): void {
  const unsupported = [
    options.debug ? '--debug' : undefined,
    options.refresh === false ? '--no-refresh' : undefined,
    options.yolo ? '--yolo' : undefined,
    options.permissionMode !== undefined ? '--permission-mode' : undefined,
    options.inheritAll ? '--inherit-all' : undefined,
    options.inheritProject ? '--inherit-project' : undefined,
    options.inheritUser ? '--inherit-user' : undefined,
    options.inheritLocal ? '--inherit-local' : undefined,
    options.settings !== undefined ? '--settings' : undefined,
    options.extraArgs !== undefined ? '--extra-args' : undefined,
    options.remoteControl ? '--remote-control' : undefined,
    options.namePrefix !== undefined ? '--name-prefix' : undefined,
  ].filter((value): value is string => value !== undefined)
  if (unsupported.length > 0) {
    throw new Error(
      `agent-harness direct execution does not support compiler-only option${unsupported.length === 1 ? '' : 's'}: ${unsupported.join(', ')}`
    )
  }
}

function resolveAgentHarnessEntrypoint(): string {
  const require = createRequire(import.meta.url)
  let packageEntry: string
  try {
    packageEntry = require.resolve('agent-harness')
  } catch {
    throw new Error(
      'The coherent agent-harness executable is unavailable from this ASP installation'
    )
  }
  let dir = dirname(packageEntry)
  while (dirname(dir) !== dir) {
    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      const pkg = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: string }
      if (pkg.name === 'agent-harness') {
        const executable = join(dir, 'bin', 'agent-harness.js')
        if (existsSync(executable)) return executable
        break
      }
    }
    dir = dirname(dir)
  }
  throw new Error('The coherent agent-harness package is missing its executable entrypoint')
}

function formatShellCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellQuote).join(' ')
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}

async function executeDirectAgentHarness(plan: DirectAgentHarnessPlan): Promise<number> {
  console.log(chalk.cyan(`Starting agent-harness ${plan.args[0]} (${plan.args[2]})`))
  const child = spawn(process.execPath, [plan.executable, ...plan.args], {
    cwd: process.cwd(),
    stdio: 'inherit',
  })
  return await new Promise((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
}

/**
 * Print the REAL RuntimeCompileRequest/Response the run compiled.
 *
 * No re-compile, no synthetic identities — these are the exact request/response
 * `run()` already produced for this invocation.
 */
function printCompilerDebugDump(runtimeCompile: { request: unknown; response: unknown }): void {
  console.log('')
  console.log(chalk.cyan('RuntimeCompileRequest'))
  console.log(JSON.stringify(runtimeCompile.request, null, 2))
  console.log('')
  console.log(chalk.cyan('RuntimeCompileResponse'))
  console.log(JSON.stringify(runtimeCompile.response, null, 2))
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
 * Check if an agent profile exists for the given target name.
 */
function hasAgentProfile(target: string): boolean {
  const agentsRoot = getAgentsRoot()
  if (!agentsRoot) return false
  return existsSync(resolve(agentsRoot, target, 'agent-profile.toml'))
}

/**
 * Detect which run mode to use based on project path and target.
 *
 * Priority:
 * 1. Space reference (space:id@selector) → global mode
 * 2. Local path with space.toml → dev mode
 * 3. Project found → project mode (target is a target name)
 * 4. Agent profile exists → project mode (use cwd as project path)
 * 5. Otherwise → invalid
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

  // No asp-targets.toml but agent profile exists — use project mode with cwd
  if (hasAgentProfile(target)) {
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
  const resolvedTarget: ResolvedRunTarget = resolveRunTarget(target)
  const runOptions = {
    ...buildCommonRunOptions(options),
    projectPath,
    projectId: resolvedTarget.projectId,
    taskId: resolvedTarget.taskId,
  }

  if (options.dryRun) {
    if (!options.printCommand) {
      console.log(chalk.yellow('Dry run - building and showing command...'))
    }
    const result = await run(resolvedTarget.targetName, {
      ...runOptions,
      dryRun: true,
      prompt,
      interactive: options.interactive,
    })
    return result
  }

  const interactive = options.interactive !== false
  if (interactive) {
    console.log(chalk.blue(`Running target "${resolvedTarget.displayTarget}" interactively...`))
    console.log(chalk.gray('Press Ctrl+C to exit'))
  } else {
    console.log(chalk.blue(`Running target "${resolvedTarget.displayTarget}" non-interactively...`))
  }
  console.log('')

  const result = await run(resolvedTarget.targetName, {
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
  const registryPath = getRegistryPath({
    projectPath: process.cwd(),
    aspHome,
    ...(options.registry ? { registryPath: options.registry } : {}),
  })
  const spacePath = `${registryPath}/spaces/${spaceRef.id}`

  if (spaceRef.defaultedToDev && !options.printCommand) {
    console.log(
      chalk.yellow(
        `Warning: No selector specified for "${spaceRef.id}", using @dev (working directory)`
      )
    )
    console.log(chalk.gray(`  Path: ${spacePath}`))
    console.log('')
  }

  if (options.dryRun) {
    if (!options.printCommand) {
      console.log(chalk.yellow('Dry run - building and showing command...'))
    }
  } else {
    console.log(chalk.blue(`Running space "${target}" in global mode...`))
  }

  const globalOptions = {
    ...buildCommonRunOptions(options),
    interactive: options.interactive !== false,
    prompt,
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

  const devOptions = {
    ...buildCommonRunOptions(options),
    interactive: options.interactive !== false,
    prompt,
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
    chalk.gray('  Global mode:  asp run space:my-space         (uses @dev from agents root)')
  )
  console.error(chalk.gray('  Dev mode:     asp run ./path/to/space'))
  process.exit(1)
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
      'Coding agent harness to use (default: claude; supported: claude, codex, pi)'
    )
    .option('--model <model>', 'Model override')
    .option('--model-reasoning-effort <effort>', 'Codex model reasoning effort override')
    .option('--permission-mode <mode>', 'Claude permission mode (--permission-mode)')
    .option('--no-interactive', 'Run non-interactively')
    .option('--dry-run', 'Print the harness command without executing')
    .option('--print-command', 'Output only the command (for piping/scripting)')
    .option('--no-refresh', 'Skip refresh and use cached project bundles')
    .option('--yolo', 'Skip all permission prompts (--dangerously-skip-permissions)')
    .option('--debug', 'Enable Claude hook debugging (--debug hooks)')
    .option('--inherit-all', 'Inherit all harness settings (user, project, local)')
    .option('--inherit-project', 'Inherit project-level settings')
    .option('--inherit-user', 'Inherit user-level settings')
    .option('--inherit-local', 'Inherit local settings')
    .option('--settings <file-or-json>', 'Path to settings JSON file or JSON string')
    .option('--resume [session-id]', 'Resume a previous session (opens picker if no ID provided)')
    .option('--remote-control', 'Enable remote control via TCP (Claude --remote-control)')
    .option('--name-prefix <prefix>', 'Prefix prepended to the auto-generated session name')
    .option('--page-prompts', 'Page prompt output one screenful at a time (q to skip)')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--extra-args <args...>', 'Additional harness CLI arguments')
    .action(async (target: string, prompt: string | undefined, options: RunOptions) => {
      // Validate harness option
      options.harness = validateOptionalHarness(options.harness)
      const projectPath = options.project ?? (await findProjectRoot())

      // --print-command implies dry-run but with silent output
      if (options.printCommand) {
        options.dryRun = true
      }

      try {
        const mode = await detectRunMode(projectPath, target)
        if (mode === 'global' || mode === 'dev') {
          if (options.harness === 'agent-harness') throwDirectAgentProfileError(target)
        }
        if (mode === 'project') {
          // This branch must precede buildCommonRunOptions(), whose compiler
          // runtime would otherwise make direct execution adapter-backed.
          const directPlan = planDirectAgentHarness(
            resolveRunTarget(target),
            projectPath ?? process.cwd(),
            prompt,
            options
          )
          if (directPlan !== undefined) {
            if (options.printCommand) {
              console.log(directPlan.semanticCommand)
              process.exit(0)
            }
            if (options.dryRun) {
              console.log(chalk.yellow('Dry run - direct agent-harness launch:'))
              console.log(directPlan.semanticCommand)
              process.exit(0)
            }
            process.exit(await executeDirectAgentHarness(directPlan))
          }
        }
        let result: RunResult

        switch (mode) {
          case 'project':
            // projectPath may be null when falling back to agent profile mode (no asp-targets.toml)
            result = await runProjectMode(target, prompt, projectPath ?? process.cwd(), options)
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

        // In dry-run mode, print the system prompt, reminder, and command with formatting
        if (options.dryRun) {
          await displayRunResultPrompts(result, options.pagePrompts)
          if (options.debug && result.runtimeCompile) {
            printCompilerDebugDump(result.runtimeCompile)
          }
        }

        process.exit(result.exitCode)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
