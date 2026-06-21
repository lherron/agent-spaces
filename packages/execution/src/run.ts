/**
 * Harness launch orchestration (run command).
 *
 * Orchestrates the full run process for project targets: ensures the target
 * is installed under ASP_HOME project bundles, loads the composed bundle,
 * launches the harness with adapter-built args/env, and returns the result.
 *
 * Helpers and global/dev modes live under ./run/.
 */

import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  type AgentLocalComponents,
  type BuildResult,
  type HarnessAdapter,
  type HarnessId,
  type HarnessRunOptions,
  LOCK_FILENAME,
  type LockFile,
  PathResolver,
  type SpaceRefString,
  install as configInstall,
  getAgentsRoot,
  getAspHome,
  getLegacyProjectHarnessOutputPath,
  getRegistryPath,
  isSpaceRefString,
  loadProjectManifest,
  lockFileExists,
  materializeFromRefs,
  readLockJson,
  sweepAspTempArtifacts,
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
  type AgentBrainEnvResult,
  type AgentBrainRuntimeContext,
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
  moveDirWithCopyFallback,
  pathExists,
  resolveRunEnvFlags,
  toHarnessRunOptions,
} from './run/util.js'

/** Warning code emitted for execution-time (post-compile) run warnings. */
const RUN_WARNING_CODE = 'W401'

interface MaterializationIdentity {
  agentId: string
  projectId: string
  frontend: HarnessId
}

interface RunInstallArgs {
  targetName: string
  options: RunOptions
  effectiveCompose: SpaceRefString[] | undefined
  effectiveRegistryPath: string
  lockPath: string
  harnessId: HarnessId
  adapter: HarnessAdapter
  agentLocalComponents: AgentLocalComponents | undefined
  agentRoot: string | undefined
  materializationIdentity: MaterializationIdentity | undefined
  currentHarnessOutputPath: string
}

interface BuildProjectRunCompilerContextArgs {
  targetName: string
  options: RunOptions
  aspHome: string
  effectiveRegistryPath: string
  harnessId: HarnessId
  runOptions: HarnessRunOptions
  agentRoot: string | undefined
  projectId: string
  taskId: string | undefined
  effectivePrompt: string | undefined
  bundleRootDir: string
  materializedHarnessOutputPath: string
  lock: LockFile
}

export async function migrateLegacyProjectHarnessOutput(
  aspHome: string,
  projectPath: string,
  targetName: string,
  harnessId: string,
  outputPath: string
): Promise<void> {
  const legacyOutputPath = getLegacyProjectHarnessOutputPath(
    projectPath,
    targetName,
    harnessId,
    aspHome
  )
  if (outputPath === legacyOutputPath) {
    return
  }
  if (await pathExists(outputPath)) {
    return
  }
  if (!(await pathExists(legacyOutputPath))) {
    return
  }

  await moveDirWithCopyFallback(legacyOutputPath, outputPath)
}

async function installRunTarget(args: RunInstallArgs): Promise<string> {
  const effectiveCompose = args.effectiveCompose
  if (effectiveCompose !== undefined) {
    return materializeComposedRunTarget({ ...args, effectiveCompose })
  }

  return installConfiguredRunTarget(args)
}

async function materializeComposedRunTarget(
  args: RunInstallArgs & { effectiveCompose: SpaceRefString[] }
): Promise<string> {
  const materializeOptions = {
    targetName: args.targetName,
    refs: args.effectiveCompose,
    registryPath: args.effectiveRegistryPath,
    lockPath: args.lockPath,
    projectPath: args.options.projectPath,
    harness: args.harnessId,
    adapter: args.adapter,
    fetchRegistry: false,
    ...(args.options.aspHome !== undefined ? { aspHome: args.options.aspHome } : {}),
    ...(args.options.refresh !== undefined ? { refresh: args.options.refresh } : {}),
    ...(args.options.inheritProject !== undefined
      ? { inheritProject: args.options.inheritProject }
      : {}),
    ...(args.options.inheritUser !== undefined ? { inheritUser: args.options.inheritUser } : {}),
    ...(args.agentLocalComponents ? { agentLocalComponents: args.agentLocalComponents } : {}),
    ...(args.agentRoot ? { agentRoot: args.agentRoot } : {}),
    projectRoot: args.options.projectPath,
    ...(args.materializationIdentity !== undefined
      ? { materializationIdentity: args.materializationIdentity }
      : {}),
  }
  const materialized = await materializeFromRefs(materializeOptions)
  return materialized.materialization.outputPath
}

async function installConfiguredRunTarget(args: RunInstallArgs): Promise<string> {
  const installOptions = {
    ...args.options,
    harness: args.harnessId,
    targets: [args.targetName],
    registryPath: args.effectiveRegistryPath,
    adapter: args.adapter,
    fetchRegistry: false,
    ...(args.agentRoot ? { agentPath: args.agentRoot } : {}),
    ...(args.agentLocalComponents ? { agentLocalComponents: args.agentLocalComponents } : {}),
    ...(args.materializationIdentity !== undefined
      ? { materializationIdentity: args.materializationIdentity }
      : {}),
  }
  const installed = await configInstall(installOptions)
  return (
    installed.materializations.find((entry) => entry.target === args.targetName)?.outputPath ??
    args.currentHarnessOutputPath
  )
}

function buildProjectRunCompilerContext(
  args: BuildProjectRunCompilerContextArgs
): Parameters<typeof maybeCompileForRun>[0]['buildContext'] {
  return () => {
    const placementAgentRoot =
      args.agentRoot ??
      join(
        getAgentsRoot({ aspHome: args.aspHome }) ?? dirname(args.options.projectPath),
        args.targetName
      )
    const compilerCwd = args.runOptions.cwd ?? args.options.cwd ?? args.options.projectPath
    const placementBase = {
      agentRoot: placementAgentRoot,
      projectRoot: args.options.projectPath,
      cwd: compilerCwd,
      runMode: 'query',
      dryRun: args.options.dryRun === true,
      ...(args.options.env !== undefined ? { env: args.options.env } : {}),
    }
    const placementBundle =
      args.agentRoot !== undefined
        ? {
            kind: 'agent-project',
            agentName: args.targetName,
            projectRoot: args.options.projectPath,
          }
        : { kind: 'compose', compose: args.lock.targets[args.targetName]?.compose ?? [] }
    const placement = { ...placementBase, bundle: placementBundle }
    const scopeRef = `agent:${args.targetName}:project:${args.projectId}${
      args.taskId ? `:task:${args.taskId}` : ''
    }`
    return {
      aspHome: args.aspHome,
      registryPath: args.effectiveRegistryPath,
      harnessId: args.harnessId,
      model: args.runOptions.model,
      reasoningEffort: args.runOptions.modelReasoningEffort,
      interactive: args.runOptions.interactive,
      yolo: args.runOptions.yolo,
      placement,
      initialPrompt: args.effectivePrompt,
      resolvedBundleHint: {
        bundleIdentity: `asp-run:${args.options.projectPath}:${args.targetName}:${args.harnessId}`,
        root: args.bundleRootDir,
        targetName: args.targetName,
        targetDir: args.materializedHarnessOutputPath,
        lockHash: args.lock.targets[args.targetName]?.envHash,
      },
      correlation: {
        appSessionKey: `${args.projectId}:${args.taskId}`,
        scopeRef,
        laneRef: 'main',
      },
    }
  }
}

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
    projectPath: options.projectPath,
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
    paths.projectHarnessBundleRoot(options.projectPath, targetName),
    targetName
  )
  debugLog('harness output path', harnessOutputPath)

  await migrateLegacyProjectHarnessOutput(
    aspHome,
    options.projectPath,
    targetName,
    harnessId,
    harnessOutputPath
  )

  if (adapter.id === 'codex') {
    await migrateLegacyProjectCodexRuntimeHome(aspHome, options.projectPath, targetName)
  }

  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lockExists = await lockFileExists(lockPath)
  const existingLock = lockExists ? await readLockJson(lockPath) : undefined
  const effectiveRegistryPath = options.registryPath ?? getRegistryPath(options)
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
  const { agentId, projectId, taskId, effectivePrompt } = resolveRunIdentity({
    agentProfile,
    projectPath: options.projectPath,
    aspHome: options.aspHome,
    defaultPrompt,
    userPrompt: options.prompt,
    projectId: options.projectId,
    taskId: options.taskId,
  })
  const materializationIdentity =
    agentId !== undefined
      ? {
          agentId,
          projectId: options.projectId ?? basename(options.projectPath),
          frontend: harnessId,
        }
      : undefined
  let materializedHarnessOutputPath = harnessOutputPath
  if (needsInstall) {
    debugLog('install', options.refresh ? '(refresh)' : '(missing output)')
    materializedHarnessOutputPath = await installRunTarget({
      targetName,
      options,
      effectiveCompose,
      effectiveRegistryPath,
      lockPath,
      harnessId,
      adapter,
      agentLocalComponents,
      agentRoot: agentProfile?.agentRoot,
      materializationIdentity,
      currentHarnessOutputPath: materializedHarnessOutputPath,
    })
    debugLog('install done')
  }

  debugLog('read lock')
  const lock = await readLockJson(lockPath)
  debugLog('lock ok')

  const bundle = await adapter.loadTargetBundle(materializedHarnessOutputPath, targetName)
  debugLog('loadTargetBundle ok')

  const cliRunOptions: HarnessRunOptions = toHarnessRunOptions(options, {
    aspHome,
    projectPath: options.projectPath,
    taskId,
    cwd: options.cwd,
    prompt: effectivePrompt,
  })

  let budget: RunSystemPromptBudget = {}
  let reminderContent: string | undefined
  if (agentProfile) {
    debugLog('materializeSystemPrompt start')
    await sweepAspTempArtifacts({ aspHome }).catch(() => {})
    const launchOverlayDir = join(aspHome, 'tmp', 'launch-overlays', randomUUID())
    const materialized = await materializeRunSystemPrompt({
      agentProfile,
      harnessOutputPath: launchOverlayDir,
      agentId,
      projectPath: options.projectPath,
      projectId,
      taskId,
    }).finally(async () => {
      await rm(launchOverlayDir, { recursive: true, force: true }).catch(() => {})
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
    buildContext: buildProjectRunCompilerContext({
      targetName,
      options,
      aspHome,
      effectiveRegistryPath,
      harnessId,
      runOptions,
      agentRoot: agentProfile?.agentRoot,
      projectId,
      taskId,
      effectivePrompt,
      bundleRootDir: bundle.rootDir,
      materializedHarnessOutputPath,
      lock,
    }),
  })
  debugLog('compileRuntime ok', compileOutcome?.ok)

  debugLog('executeHarnessRun start', compiledLaunch ? '(via compiler)' : '(legacy)')
  const executionLaunch = runOptions.launchSurface === 'codex-app' ? undefined : compiledLaunch
  const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
    env: options.env,
    dryRun: options.dryRun,
    reminderContent,
    pagePrompts: options.pagePrompts,
    ...(executionLaunch ? { compiledLaunch: executionLaunch } : {}),
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
      code: RUN_WARNING_CODE,
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
