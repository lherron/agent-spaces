/**
 * Harness launch orchestration (run command).
 *
 * Orchestrates the full run process for project targets: ensures the target
 * is installed under ASP_HOME project bundles, loads the composed bundle,
 * launches the harness with adapter-built args/env, and returns the result.
 *
 * Helpers and global/dev modes live under ./run/.
 */

import { basename, dirname, join } from 'node:path'
import {
  type BuildResult,
  type HarnessRunOptions,
  LOCK_FILENAME,
  PathResolver,
  type SpaceRefString,
  install as configInstall,
  getAgentsRoot,
  getAspHome,
  getRegistryPath,
  isSpaceRefString,
  loadProjectManifest,
  lockFileExists,
  materializeFromRefs,
  readLockJson,
} from 'spaces-config'

import { migrateLegacyProjectCodexRuntimeHome } from './run-codex.js'
export {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  migrateLegacyProjectCodexRuntimeHome,
  prepareCodexRuntimeHome,
} from './run-codex.js'

import { detectAgentLocalComponents, resolveAgentRunDefaults } from './run/agent-profile.js'
export {
  prepareAgentBrainRuntime,
  resolveAgentBrainRuntime,
  type AgentBrainEnvResult,
  type AgentBrainRuntimeContext,
  type BrainRuntimeResolution,
  type EnabledAgentBrainEnvResult,
  type GbrainCommandRunner,
} from './run/agent-brain.js'
export {
  prepareAgentToolRuntime,
  validateAgentTools,
  type AgentToolEnvResult,
  type AgentToolRuntimeContext,
} from './run/agent-tools.js'
import { maybeCompileForRun } from './run/compiler-debug.js'
import { executeHarnessRun } from './run/execute.js'
import {
  type RunSystemPromptBudget,
  materializeRunSystemPrompt,
  resolveRunIdentity,
} from './run/identity.js'
import {
  type PlacementRuntimeModelResolution,
  type PlacementRuntimePlan,
  type PlanPlacementRuntimeOptions,
  planPlacementRuntime,
  planProjectTargetRuntime,
} from './run/placement-plan.js'
import { runGlobalSpace, runLocalSpace } from './run/space-launch.js'
import type {
  CompileRuntimeFn,
  GlobalRunOptions,
  LaunchShape,
  RunCompileOutcome,
  RunCompilerDebugContext,
  RunInvocationResult,
  RunOptions,
  RunResult,
} from './run/types.js'
import {
  composeArraysMatch,
  mergeDefined,
  pathExists,
  resolveRunEnvFlags,
  toHarnessRunOptions,
} from './run/util.js'

export {
  detectAgentLocalComponents,
  resolveAgentRunDefaults,
  planPlacementRuntime,
  runGlobalSpace,
  runLocalSpace,
  type CompileRuntimeFn,
  type GlobalRunOptions,
  type LaunchShape,
  type PlacementRuntimeModelResolution,
  type PlacementRuntimePlan,
  type PlanPlacementRuntimeOptions,
  type RunCompileOutcome,
  type RunCompilerDebugContext,
  type RunInvocationResult,
  type RunOptions,
  type RunResult,
}

export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  const { debugRun: debug, viaCompiler } = resolveRunEnvFlags()
  const runStart = performance.now()
  let lastMark = runStart
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      const now = performance.now()
      const total = (now - runStart).toFixed(1)
      const delta = (now - lastMark).toFixed(1)
      lastMark = now
      console.error(`[asp run +${total}ms Δ${delta}ms]`, ...args)
    }
  }

  debugLog('start')
  const aspHome = options.aspHome ?? getAspHome()
  debugLog('load manifest')
  const manifest = await loadProjectManifest(options.projectPath, aspHome)
  debugLog('manifest ok')

  const runtimePlan = planProjectTargetRuntime(manifest, targetName, {
    aspHome,
    harness: options.harness,
  })
  debugLog('plan ok')
  const {
    agentProfile,
    harnessId,
    adapter,
    defaultPrompt,
    effectiveCompose,
    defaultRunOptions: defaults,
  } = runtimePlan
  const agentLocalComponents = agentProfile
    ? await detectAgentLocalComponents(agentProfile.agentRoot)
    : undefined
  debugLog('detectAgentLocalComponents ok')

  debugLog('detect harness', harnessId)
  const detection = await adapter.detect()
  debugLog('detect ok', detection.available ? (detection.version ?? 'unknown') : 'unavailable')

  const paths = new PathResolver({ aspHome })
  const harnessOutputPath = adapter.getTargetOutputPath(
    paths.projectTargets(options.projectPath),
    targetName
  )
  debugLog('harness output path', harnessOutputPath)

  if (adapter.id === 'codex') {
    await migrateLegacyProjectCodexRuntimeHome(aspHome, options.projectPath, targetName)
  }

  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lockExists = await lockFileExists(lockPath)
  const existingLock = lockExists ? await readLockJson(lockPath) : undefined
  const composeChanged =
    effectiveCompose !== undefined &&
    !composeArraysMatch(effectiveCompose, existingLock?.targets[targetName]?.compose ?? [])
  const hasMutableAgentPromptMaterial =
    agentLocalComponents?.hasSkills === true || agentLocalComponents?.hasCommands === true
  const needsInstall =
    options.refresh ||
    !lockExists ||
    !(await pathExists(harnessOutputPath)) ||
    composeChanged ||
    hasMutableAgentPromptMaterial
  if (needsInstall) {
    debugLog('install', options.refresh ? '(refresh)' : '(missing output)')
    if (effectiveCompose !== undefined) {
      await materializeFromRefs({
        targetName,
        refs: effectiveCompose,
        registryPath: getRegistryPath(options),
        lockPath,
        projectPath: options.projectPath,
        harness: harnessId,
        adapter,
        fetchRegistry: false,
        ...(options.aspHome !== undefined ? { aspHome: options.aspHome } : {}),
        ...(options.refresh !== undefined ? { refresh: options.refresh } : {}),
        ...(options.inheritProject !== undefined ? { inheritProject: options.inheritProject } : {}),
        ...(options.inheritUser !== undefined ? { inheritUser: options.inheritUser } : {}),
        ...(agentLocalComponents ? { agentLocalComponents } : {}),
        ...(agentProfile ? { agentRoot: agentProfile.agentRoot } : {}),
        projectRoot: options.projectPath,
      })
    } else {
      await configInstall({
        ...options,
        harness: harnessId,
        targets: [targetName],
        adapter,
        fetchRegistry: false,
        ...(agentProfile ? { agentPath: agentProfile.agentRoot } : {}),
        ...(agentLocalComponents ? { agentLocalComponents } : {}),
      })
    }
    debugLog('install done')
  }

  debugLog('read lock')
  const lock = await readLockJson(lockPath)
  debugLog('lock ok')

  const bundle = await adapter.loadTargetBundle(harnessOutputPath, targetName)
  debugLog('loadTargetBundle ok')

  const { agentId, projectId, taskId, effectivePrompt } = resolveRunIdentity({
    agentProfile,
    projectPath: options.projectPath,
    aspHome: options.aspHome,
    defaultPrompt,
    userPrompt: options.prompt,
    projectId: options.projectId,
    taskId: options.taskId,
  })

  const cliRunOptions: HarnessRunOptions = toHarnessRunOptions(options, {
    aspHome,
    projectPath: options.projectPath,
    cwd: options.cwd,
    prompt: effectivePrompt,
  })

  let budget: RunSystemPromptBudget = {}
  let reminderContent: string | undefined
  if (agentProfile) {
    debugLog('materializeSystemPrompt start')
    const materialized = await materializeRunSystemPrompt({
      agentProfile,
      harnessOutputPath,
      agentId,
      projectPath: options.projectPath,
      projectId,
      taskId,
    })
    debugLog('materializeSystemPrompt ok')
    budget = materialized.budget
    reminderContent = materialized.reminderContent
    if (materialized.systemPrompt !== undefined) {
      cliRunOptions.systemPrompt = materialized.systemPrompt
      cliRunOptions.systemPromptMode = materialized.systemPromptMode
    }
    if (materialized.reminderContent !== undefined) {
      cliRunOptions.reminderContent = materialized.reminderContent
    }
  }

  const runOptions = mergeDefined(defaults, cliRunOptions)

  if (runOptions.interactive === false && runOptions.prompt === undefined) {
    throw new Error(
      'Non-interactive mode requires a prompt (provide [prompt] or configure targets.<name>.priming_prompt)'
    )
  }

  debugLog('run options', {
    prompt: options.prompt,
    interactive: options.interactive,
    dryRun: options.dryRun,
  })

  // Compile through the injected compiler when needed: to dump the REAL plan for
  // `--debug`, and/or — behind the ASP_RUN_VIA_COMPILER gate — to drive the
  // foreground inherit-spawn from the compiled TerminalExecutionProfile instead
  // of the legacy adapter argv path. ONE compile, no synthetic identities.
  const wantDebugDump = options.dryRun === true && options.debug === true
  debugLog('compileRuntime start')
  const { compileOutcome, compiledLaunch } = await maybeCompileForRun({
    compileRuntime: options.compileRuntime,
    viaCompiler,
    wantDebugDump,
    buildContext: () => {
      const placementAgentRoot =
        agentProfile?.agentRoot ??
        join(getAgentsRoot({ aspHome }) ?? dirname(options.projectPath), targetName)
      const compilerCwd = runOptions.cwd ?? options.cwd ?? options.projectPath
      const placement =
        agentProfile !== undefined
          ? {
              agentRoot: placementAgentRoot,
              projectRoot: options.projectPath,
              cwd: compilerCwd,
              runMode: 'query',
              bundle: {
                kind: 'agent-project',
                agentName: targetName,
                projectRoot: options.projectPath,
              },
              dryRun: options.dryRun === true,
              ...(options.env !== undefined ? { env: options.env } : {}),
            }
          : {
              agentRoot: placementAgentRoot,
              projectRoot: options.projectPath,
              cwd: compilerCwd,
              runMode: 'query',
              bundle: { kind: 'compose', compose: lock.targets[targetName]?.compose ?? [] },
              dryRun: options.dryRun === true,
              ...(options.env !== undefined ? { env: options.env } : {}),
            }
      const scopeRef = `${targetName}@${projectId}${taskId ? `:${taskId}` : ''}`
      return {
        aspHome,
        harnessId,
        model: runOptions.model,
        reasoningEffort: runOptions.modelReasoningEffort,
        interactive: runOptions.interactive,
        yolo: runOptions.yolo,
        placement,
        initialPrompt: effectivePrompt,
        resolvedBundleHint: {
          bundleIdentity: `asp-run:${options.projectPath}:${targetName}:${harnessId}`,
          root: bundle.rootDir,
          targetName,
          targetDir: harnessOutputPath,
          lockHash: lock.targets[targetName]?.envHash,
        },
        correlation: {
          appSessionKey: `${projectId}:${taskId}`,
          scopeRef,
          laneRef: 'main',
        },
      }
    },
  })
  debugLog('compileRuntime ok', compileOutcome?.ok)

  debugLog('executeHarnessRun start', compiledLaunch ? '(via compiler)' : '(legacy)')
  const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
    env: options.env,
    dryRun: options.dryRun,
    reminderContent,
    pagePrompts: options.pagePrompts,
    ...(compiledLaunch ? { compiledLaunch } : {}),
    ...(agentProfile
      ? {
          agentBrainRuntime: {
            agentRoot: agentProfile.agentRoot,
            agentName: basename(agentProfile.agentRoot),
            ...(agentLocalComponents ? { components: agentLocalComponents } : {}),
          },
        }
      : {}),
    ...(agentProfile && agentLocalComponents
      ? {
          agentToolRuntime: {
            agentRoot: agentProfile.agentRoot,
            projectRoot: options.projectPath,
            components: agentLocalComponents,
          },
        }
      : {}),
  })
  debugLog('executeHarnessRun ok')

  const buildResult: BuildResult = {
    pluginDirs: bundle.pluginDirs ?? [],
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
    warnings: execution.warnings.map((message) => ({
      code: 'W401',
      severity: 'warning',
      message,
    })),
    lock,
  }

  return {
    build: buildResult,
    invocation: execution.invocation,
    exitCode: execution.exitCode,
    command: execution.command,
    displayCommand: execution.displayCommand,
    systemPrompt: execution.systemPrompt,
    systemPromptMode: execution.systemPromptMode,
    reminderContent,
    maxChars: budget.maxChars,
    promptSectionSizes: budget.promptSectionSizes,
    reminderSectionSizes: budget.reminderSectionSizes,
    totalContextChars: budget.totalContextChars,
    nearMaxChars: budget.nearMaxChars,
    primingPrompt: effectivePrompt,
    ...(compileOutcome
      ? { runtimeCompile: { request: compileOutcome.request, response: compileOutcome.response } }
      : {}),
    launch: execution.launch,
  }
}

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

export async function runInteractive(
  targetName: string,
  options: Omit<RunOptions, 'interactive'>
): Promise<RunResult> {
  return run(targetName, {
    ...options,
    interactive: true,
  })
}

export function isSpaceReference(value: string): value is SpaceRefString {
  return isSpaceRefString(value)
}
