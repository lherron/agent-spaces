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
  getAspHome,
  getRegistryPath,
  inferProjectIdFromCwd,
  isSpaceRefString,
  loadProjectManifest,
  lockFileExists,
  materializeFromRefs,
  readLockJson,
} from 'spaces-config'
import { expandTemplate, materializeSystemPrompt } from 'spaces-runtime'

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
import { type MaterializedPromptResult, executeHarnessRun } from './run/execute.js'
import {
  type PlacementRuntimeModelResolution,
  type PlacementRuntimePlan,
  type PlanPlacementRuntimeOptions,
  planPlacementRuntime,
  planProjectTargetRuntime,
} from './run/placement-plan.js'
import { runGlobalSpace, runLocalSpace } from './run/space-launch.js'
import type { GlobalRunOptions, RunInvocationResult, RunOptions, RunResult } from './run/types.js'
import {
  combinePrompts,
  composeArraysMatch,
  mergeDefined,
  pathExists,
  resolveInteractive,
} from './run/util.js'

const DEFAULT_RUN_TASK_ID = 'primary'

export {
  detectAgentLocalComponents,
  resolveAgentRunDefaults,
  planPlacementRuntime,
  runGlobalSpace,
  runLocalSpace,
  type GlobalRunOptions,
  type PlacementRuntimeModelResolution,
  type PlacementRuntimePlan,
  type PlanPlacementRuntimeOptions,
  type RunInvocationResult,
  type RunOptions,
  type RunResult,
}

export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  const debug = process.env['ASP_DEBUG_RUN'] === '1'
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
  const combinedPrompt = combinePrompts(defaultPrompt, options.prompt)
  const agentId = agentProfile ? basename(agentProfile.agentRoot) : undefined
  const projectId =
    options.projectId ??
    inferProjectIdFromCwd({
      cwd: options.projectPath,
      ...(options.aspHome !== undefined ? { aspHome: options.aspHome } : {}),
    }) ??
    basename(options.projectPath)
  const taskId = options.taskId ?? process.env['ASP_TASK_ID'] ?? DEFAULT_RUN_TASK_ID
  const expansionContext = agentProfile
    ? {
        agentRoot: agentProfile.agentRoot,
        agentsRoot: dirname(agentProfile.agentRoot),
        agentId,
        agentName: agentId,
        projectRoot: options.projectPath,
        projectId,
        taskId,
        runMode: 'query',
      }
    : undefined
  const effectivePrompt =
    combinedPrompt !== undefined && expansionContext !== undefined
      ? expandTemplate(combinedPrompt, expansionContext)
      : combinedPrompt
  const cliRunOptions: HarnessRunOptions = {
    aspHome,
    model: options.model,
    modelReasoningEffort: options.modelReasoningEffort,
    extraArgs: options.extraArgs,
    interactive: resolveInteractive(options.interactive),
    prompt: effectivePrompt,
    settingSources: options.settingSources,
    permissionMode: options.permissionMode,
    settings: options.settings,
    yolo: options.yolo,
    debug: options.debug,
    projectPath: options.projectPath,
    cwd: options.cwd,
    artifactDir: options.artifactDir,
    continuationKey: options.continuationKey,
    remoteControl: options.remoteControl,
    sessionNamePrefix: options.sessionNamePrefix,
  }
  let reminderContent: string | undefined
  let maxChars: number | undefined
  let promptSectionSizes: string[] | undefined
  let reminderSectionSizes: string[] | undefined
  let totalContextChars: number | undefined
  let nearMaxChars: boolean | undefined
  if (agentProfile) {
    debugLog('materializeSystemPrompt start')
    const systemPrompt = await materializeSystemPrompt(harnessOutputPath, {
      agentRoot: agentProfile.agentRoot,
      ...(agentId !== undefined ? { agentId } : {}),
      projectRoot: options.projectPath,
      projectId,
      taskId,
      runMode: 'query',
    })
    debugLog('materializeSystemPrompt ok')
    if (systemPrompt) {
      const materializedPrompt = systemPrompt as MaterializedPromptResult
      reminderContent = materializedPrompt.reminderContent
      maxChars = materializedPrompt.maxChars
      promptSectionSizes = materializedPrompt.promptSectionSizes
      reminderSectionSizes = materializedPrompt.reminderSectionSizes
      totalContextChars = materializedPrompt.totalContextChars
      nearMaxChars = materializedPrompt.nearMaxChars
      if (materializedPrompt.content.length > 0) {
        cliRunOptions.systemPrompt = materializedPrompt.content
        cliRunOptions.systemPromptMode = materializedPrompt.mode
      }
      if (reminderContent) {
        cliRunOptions.reminderContent = reminderContent
      }
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

  debugLog('executeHarnessRun start')
  const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
    env: options.env,
    dryRun: options.dryRun,
    reminderContent,
    pagePrompts: options.pagePrompts,
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
    maxChars,
    promptSectionSizes,
    reminderSectionSizes,
    totalContextChars,
    nearMaxChars,
    primingPrompt: effectivePrompt,
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
