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

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import { parseScopeHandle } from 'agent-scope'
import { type RuntimeCompileRequest, createAgentSpacesClient } from 'agent-spaces'
import chalk from 'chalk'
import type { Command } from 'commander'
import {
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import { getAgentsRoot, parseSpaceRef } from 'spaces-config'
import {
  type HarnessId,
  type RunCompilerDebugContext,
  type RunResult,
  harnessRegistry,
  isHarnessId,
  isSpaceReference,
  run,
  runGlobalSpace,
  runLocalSpace,
} from 'spaces-execution'

import { exitWithAspError, logInvocationOutput } from '../helpers.js'
import { findProjectRoot } from '../lib.js'
import { displayPrompts } from '../prompt-display.js'

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

interface ProjectRunTarget {
  targetName: string
  displayTarget: string
  projectId?: string | undefined
  taskId?: string | undefined
}

function resolveProjectRunTarget(target: string): ProjectRunTarget {
  if (!target.includes('@')) {
    return { targetName: target, displayTarget: target }
  }

  try {
    const parsed = parseScopeHandle(target)
    if (parsed.projectId === undefined) {
      return { targetName: target, displayTarget: target }
    }

    return {
      targetName: parsed.agentId,
      displayTarget: target,
      projectId: parsed.projectId,
      taskId: parsed.taskId,
    }
  } catch {
    return { targetName: target, displayTarget: target }
  }
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

function compilerDebugId(prefix: string, seed: string): string {
  const sanitized = seed.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'asp_run'
  return `${prefix}_asp_run_debug_${sanitized}`
}

function allocateCompilerDebugIdentity(
  context: RunCompilerDebugContext
): RuntimeIdentityAllocation {
  const seed = `${context.correlation.appSessionKey}:${context.requested.preferredHarnessRuntime ?? 'runtime'}`
  return {
    requestId: compilerDebugId('request', seed) as RuntimeIdentityAllocation['requestId'],
    operationId: compilerDebugId(
      'runtimeOperation',
      seed
    ) as RuntimeIdentityAllocation['operationId'],
    hostSessionId: compilerDebugId(
      'hostSession',
      seed
    ) as RuntimeIdentityAllocation['hostSessionId'],
    generation: 1,
    runtimeId: compilerDebugId('runtime', seed) as RuntimeIdentityAllocation['runtimeId'],
    invocationId: compilerDebugId('inv', seed) as RuntimeIdentityAllocation['invocationId'],
    initialInputId: compilerDebugId('input', seed) as RuntimeIdentityAllocation['initialInputId'],
    runId: compilerDebugId('run', seed) as RuntimeIdentityAllocation['runId'],
    traceId: compilerDebugId('trace', seed) as RuntimeIdentityAllocation['traceId'],
    idempotencyKey: `asp-run-debug:${seed}`,
  }
}

function normalizeReasoningEffort(
  value: string | undefined
): RuntimeCompileRequest['requested']['reasoningEffort'] {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  return undefined
}

function buildCompilerDebugRequest(context: RunCompilerDebugContext): RuntimeCompileRequest {
  const identity = allocateCompilerDebugIdentity(context)
  const now = new Date().toISOString()
  const placement = {
    ...context.placement,
    correlation: {
      ...(typeof context.placement['correlation'] === 'object' &&
      context.placement['correlation'] !== null
        ? (context.placement['correlation'] as Record<string, unknown>)
        : {}),
      sessionRef: {
        scopeRef: context.correlation.scopeRef ?? context.correlation.appSessionKey,
        laneRef: context.correlation.laneRef ?? 'main',
      },
      hostSessionId: identity.hostSessionId,
    },
  }

  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: context.requested.modelProvider,
      model: context.requested.model,
      reasoningEffort: normalizeReasoningEffort(context.requested.reasoningEffort),
      harnessFamily: context.requested.harnessFamily,
      preferredHarnessRuntime: context.requested.preferredHarnessRuntime,
      interactionMode: context.requested.interactionMode,
    },
    materialization: {
      initialPrompt: context.materialization.initialPrompt,
      resolvedBundleHint: context.materialization
        .resolvedBundleHint as RuntimeCompileRequest['materialization']['resolvedBundleHint'],
    },
    hrcPolicy: {
      permissionPolicy:
        context.hrcPolicy.yolo === true
          ? {
              mode: 'allow',
              audit: true,
              provenance: {
                source: 'operator-config',
                requestId: identity.requestId,
                createdAt: now,
              },
            }
          : { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 120_000, turnTimeoutMs: 120_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces',
      appSessionKey: context.correlation.appSessionKey,
      scopeRef: context.correlation.scopeRef,
      laneRef: context.correlation.laneRef ?? 'main',
    },
  }
}

async function printCompilerDebugDump(context: RunCompilerDebugContext): Promise<void> {
  const req = buildCompilerDebugRequest(context)
  const client = createAgentSpacesClient({ aspHome: context.aspHome })
  const response = await client.compileRuntimePlan(req)

  console.log('')
  console.log(chalk.cyan('RuntimeCompileRequest'))
  console.log(JSON.stringify(req, null, 2))
  console.log('')
  console.log(chalk.cyan('RuntimeCompileResponse'))
  console.log(JSON.stringify(response, null, 2))
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
  const { existsSync } = require('node:fs') as typeof import('node:fs')
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
  const resolvedTarget = resolveProjectRunTarget(target)
  const settingSources = buildSettingSources(options)
  const runOptions = {
    projectPath,
    aspHome: options.aspHome,
    registryPath: options.registry,
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
    modelReasoningEffort: options.modelReasoningEffort,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    continuationKey: options.resume,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.namePrefix,
    pagePrompts: options.pagePrompts,
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
    modelReasoningEffort: options.modelReasoningEffort,
    inheritProject: options.inheritProject,
    inheritUser: options.inheritUser,
    continuationKey: options.resume,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.namePrefix,
    pagePrompts: options.pagePrompts,
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
    modelReasoningEffort: options.modelReasoningEffort,
    inheritProject: options.inheritProject,
    continuationKey: options.resume,
    inheritUser: options.inheritUser,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.namePrefix,
    pagePrompts: options.pagePrompts,
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
function validateHarness(harness: string | undefined): HarnessId | undefined {
  if (harness === undefined) {
    return undefined
  }

  if (!isHarnessId(harness)) {
    console.error(chalk.red(`Error: Unknown harness "${harness}"`))
    console.error(chalk.gray(''))
    console.error(chalk.gray('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.error(chalk.gray(`  - ${adapter.id}`))
    }
    process.exit(1)
  }

  return harness
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
          await displayPrompts({
            systemPrompt: result.systemPrompt,
            systemPromptMode: result.systemPromptMode,
            reminderContent: result.reminderContent,
            primingPrompt: result.primingPrompt,
            promptSectionSizes: result.promptSectionSizes,
            reminderSectionSizes: result.reminderSectionSizes,
            totalContextChars: result.totalContextChars,
            maxChars: result.maxChars,
            nearMaxChars: result.nearMaxChars,
            command: result.displayCommand ?? result.command,
            showCommand: true,
            pagePrompts: options.pagePrompts,
          })
          if (options.debug && result.compilerDebugContext) {
            await printCompilerDebugDump(result.compilerDebugContext)
          }
        }

        process.exit(result.exitCode)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
