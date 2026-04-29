/**
 * Harness launch orchestration (run command).
 *
 * Orchestrates the full run process for project targets: ensures the target
 * is installed under ASP_HOME project bundles, loads the composed bundle,
 * launches the harness with adapter-built args/env, and returns the result.
 *
 * Helpers and global/dev modes live under ./run/.
 */

import { basename, join } from 'node:path'

import {
  type BuildResult,
  type HarnessRunOptions,
  LOCK_FILENAME,
  PathResolver,
  type SpaceRefString,
  install as configInstall,
  getAspHome,
  getRegistryPath,
  isSpaceRefString,
  loadProjectManifest,
  lockFileExists,
  materializeFromRefs,
  readLockJson,
} from 'spaces-config'
import {
  discoverContextTemplate,
  materializeSystemPrompt,
  resolveContextTemplateDetailed,
} from 'spaces-runtime'

import { migrateLegacyProjectCodexRuntimeHome } from './run-codex.js'
export {
  ensureCodexProjectTrust,
  getProjectCodexRuntimeHomePath,
  migrateLegacyProjectCodexRuntimeHome,
  prepareCodexRuntimeHome,
} from './run-codex.js'

import { detectAgentLocalComponents, resolveAgentRunDefaults } from './run/agent-profile.js'
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
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      console.error('[asp run]', ...args)
    }
  }

  const aspHome = options.aspHome ?? getAspHome()
  debugLog('load manifest')
  const manifest = await loadProjectManifest(options.projectPath, aspHome)
  debugLog('manifest ok')

  const runtimePlan = planProjectTargetRuntime(manifest, targetName, {
    aspHome,
    harness: options.harness,
  })
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
  const needsInstall =
    options.refresh || !lockExists || !(await pathExists(harnessOutputPath)) || composeChanged
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
      })
    }
    debugLog('install done')
  }

  debugLog('read lock')
  const lock = await readLockJson(lockPath)
  debugLog('lock ok')

  const bundle = await adapter.loadTargetBundle(harnessOutputPath, targetName)
  const effectivePrompt = combinePrompts(defaultPrompt, options.prompt)
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
    const systemPrompt = await materializeSystemPrompt(harnessOutputPath, {
      agentRoot: agentProfile.agentRoot,
      projectRoot: options.projectPath,
      runMode: 'query',
    })
    if (systemPrompt) {
      const materializedPrompt = systemPrompt as MaterializedPromptResult
      reminderContent = materializedPrompt.reminderContent
      maxChars = materializedPrompt.maxChars
      if (materializedPrompt.content.length > 0) {
        cliRunOptions.systemPrompt = materializedPrompt.content
        cliRunOptions.systemPromptMode = materializedPrompt.mode
      }
      if (reminderContent) {
        cliRunOptions.reminderContent = reminderContent
      }
    }

    if (options.dryRun) {
      const discovered = discoverContextTemplate({
        agentRoot: agentProfile.agentRoot,
        aspHome: options.aspHome,
      })

      if (discovered.templateSource?.kind === 'context') {
        const resolved = await resolveContextTemplateDetailed(discovered.templateSource.template, {
          agentRoot: agentProfile.agentRoot,
          agentName: basename(agentProfile.agentRoot),
          agentsRoot: discovered.agentsRoot,
          projectRoot: options.projectPath,
          runMode: 'query',
          ...(discovered.profile.rawProfile ? { agentProfile: discovered.profile.rawProfile } : {}),
        })

        promptSectionSizes = resolved.diagnostics.prompt.sectionSizes
        reminderSectionSizes = resolved.diagnostics.reminder.sectionSizes
        totalContextChars = resolved.diagnostics.totalChars
        nearMaxChars = resolved.diagnostics.nearMaxChars
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

  const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
    env: options.env,
    dryRun: options.dryRun,
    reminderContent,
    pagePrompts: options.pagePrompts,
  })

  const buildResult: BuildResult = {
    pluginDirs: bundle.pluginDirs ?? [],
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
    warnings: [],
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
