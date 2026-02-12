/**
 * Harness launch orchestration (run command).
 *
 * WHY: Orchestrates the full run process:
 * - Ensure target is installed (via asp_modules)
 * - Load composed bundle from asp_modules
 * - Launch harness with adapter-built args/env
 * - Emit structured JSONL events for observability
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type ComposeTargetInput,
  type ComposedTargetBundle,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessId,
  type HarnessRunOptions,
  LOCK_FILENAME,
  type LockFile,
  type ResolvedSpaceArtifact,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  getAspModulesPath,
  harnessOutputExists,
  isHarnessSupported,
  isSpaceRefString,
  lockFileExists,
  parseSpaceRef,
  readLockJson,
  readSpaceToml,
  resolveSpaceManifest,
  serializeLockJson,
} from 'spaces-config'

import { type RunEventEmitter, createEventEmitter, getEventsOutputPath } from 'spaces-runtime'

import type { LintWarning } from 'spaces-config'

import { computeClosure, generateLockFileForTarget } from 'spaces-config'

import { PathResolver, createSnapshot, ensureDir, getAspHome } from 'spaces-config'

import type { BuildResult } from 'spaces-config'
import { type ResolveOptions, install as configInstall, loadProjectManifest } from 'spaces-config'
import { harnessRegistry } from './harness/index.js'

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatCommand(commandPath: string, args: string[]): string {
  return [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
}

/**
 * Options for run operation.
 */
export interface RunOptions extends ResolveOptions {
  /** Harness to run with (default: 'claude') */
  harness?: HarnessId | undefined
  /** Working directory for harness execution (default: projectPath) */
  cwd?: string | undefined
  /** Whether to run interactively (spawn stdio) vs capture output */
  interactive?: boolean | undefined
  /** Initial prompt to send to the harness */
  prompt?: string | undefined
  /** Additional harness CLI args */
  extraArgs?: string[] | undefined
  /** Whether to print warnings before running (default: true) */
  printWarnings?: boolean | undefined
  /** Additional environment variables to pass to harness subprocess */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing the harness */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
  /** Permission mode (--permission-mode flag) */
  permissionMode?: string | undefined
  /** Path to settings JSON file or JSON string (--settings flag) */
  settings?: string | undefined
  /** Force refresh from source (clear cache and re-materialize) */
  refresh?: boolean | undefined
  /** YOLO mode - skip all permission prompts (--dangerously-skip-permissions) */
  yolo?: boolean | undefined
  /** Debug mode - enable hook debugging (--debug hooks) */
  debug?: boolean | undefined
  /** Model override (passed through to harness) */
  model?: string | undefined
  /** Inherit project-level settings (for Pi: enables .pi/skills in project) */
  inheritProject?: boolean | undefined
  /** Inherit user-level settings (for Pi: enables ~/.pi/agent/skills) */
  inheritUser?: boolean | undefined
  /** Path to artifact directory for run outputs (events, transcripts) */
  artifactDir?: string | undefined
  /** Whether to emit JSONL events to the artifact directory */
  emitEvents?: boolean | undefined
  /** Resume a previous session (session ID or true for picker) */
  resume?: string | boolean | undefined
}

export interface RunInvocationResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Result of run operation.
 */
export interface RunResult {
  /** Build result (includes plugin dirs, warnings) */
  build: BuildResult
  /** Invocation result (if non-interactive) */
  invocation?: RunInvocationResult | undefined
  /** Exit code from harness */
  exitCode: number
  /** Full harness command (for dry-run mode) */
  command?: string | undefined
  /** Path to events JSONL file (if emitEvents was true) */
  eventsPath?: string | undefined
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
 * Format environment variables as shell prefix (e.g., "VAR=value VAR2=value2 ").
 */
function formatEnvPrefix(env: Record<string, string> | undefined): string {
  if (!env || Object.keys(env).length === 0) return ''
  return `${Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(' ')} `
}

/**
 * Merge run option defaults with overrides.
 * Undefined values in overrides do not replace defaults.
 */
function mergeDefined<T extends object>(defaults: Partial<T>, overrides: Partial<T>): T {
  const merged = { ...defaults } as T
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key]
    if (value !== undefined) {
      merged[key] = value as T[keyof T]
    }
  }
  return merged
}

function combinePrompts(
  primingPrompt: string | undefined,
  userPrompt: string | undefined
): string | undefined {
  if (primingPrompt !== undefined && userPrompt !== undefined) {
    return `${primingPrompt}\n\n${userPrompt}`
  }
  return primingPrompt ?? userPrompt
}

function resolveInteractive(interactive: boolean | undefined): boolean | undefined {
  if (interactive !== undefined) {
    return interactive
  }
  return undefined
}

interface ExecuteHarnessResult {
  exitCode: number
  invocation?: RunInvocationResult | undefined
  command: string
  eventsPath?: string | undefined
}

/**
 * Execute a generic harness command (non-Claude).
 */
async function executeHarnessCommand(
  commandPath: string,
  args: string[],
  options: {
    interactive?: boolean | undefined
    cwd?: string | undefined
    env?: Record<string, string> | undefined
  }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const captureOutput = options.interactive === false
  return new Promise((resolve, reject) => {
    const child = spawn(commandPath, args, {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: captureOutput ? 'pipe' : 'inherit',
    })

    // Close stdin immediately for non-interactive runs to signal no more input
    if (captureOutput && child.stdin) {
      child.stdin.end()
    }

    let stdout = ''
    let stderr = ''

    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })
    }

    child.on('error', (err) => {
      reject(err)
    })

    child.on('close', (code) => {
      resolve({ exitCode: code ?? 1, stdout, stderr })
    })
  })
}

async function executeHarnessRun(
  adapter: HarnessAdapter,
  detection: HarnessDetection,
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions,
  options: {
    env?: Record<string, string> | undefined
    dryRun?: boolean | undefined
  }
): Promise<ExecuteHarnessResult> {
  const artifactDir = runOptions.artifactDir
  const eventsPath =
    runOptions.emitEvents && artifactDir ? getEventsOutputPath(artifactDir) : undefined

  let eventEmitter: RunEventEmitter | undefined
  if (eventsPath) {
    eventEmitter = await createEventEmitter({
      outputPath: eventsPath,
      heartbeatIntervalMs: 30000,
    })
  }

  const args = adapter.buildRunArgs(bundle, runOptions)
  const harnessEnv: Record<string, string> = {
    ...(options.env ?? {}),
    ...adapter.getRunEnv(bundle, runOptions),
  }

  const commandPath = detection.path ?? adapter.id
  const command = formatEnvPrefix(harnessEnv) + formatCommand(commandPath, args)

  if (options.dryRun) {
    if (eventEmitter) await eventEmitter.close()
    return { exitCode: 0, command, ...(eventsPath ? { eventsPath } : {}) }
  }

  eventEmitter?.emitJobStarted({
    harness: adapter.id,
    target: bundle.targetName,
    pid: process.pid,
    cwd: runOptions.cwd ?? runOptions.projectPath,
  })

  console.log(`\x1b[90m$ ${command}\x1b[0m`)
  console.log('')

  const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
    interactive: runOptions.interactive,
    cwd: runOptions.cwd ?? runOptions.projectPath,
    env: harnessEnv,
  })

  if (stdout) {
    process.stdout.write(stdout)
  }
  if (stderr) {
    process.stderr.write(stderr)
  }

  eventEmitter?.emitJobCompleted({
    exitCode,
    outcome: exitCode === 0 ? 'success' : 'failure',
  })
  if (eventEmitter) await eventEmitter.close()

  return {
    exitCode,
    command,
    invocation:
      runOptions.interactive === false
        ? {
            exitCode,
            stdout,
            stderr,
          }
        : undefined,
    ...(eventsPath ? { eventsPath } : {}),
  }
}

/**
 * Cleanup a temporary directory, ignoring errors.
 */
async function cleanupTempDir(tempDir: string): Promise<void> {
  try {
    await rm(tempDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Print lint warnings to console if requested.
 * Returns true if there are any errors (severity: 'error').
 */
function printWarnings(warnings: LintWarning[], shouldPrint: boolean): boolean {
  let hasErrors = false
  if (!shouldPrint || warnings.length === 0) return hasErrors

  for (const warning of warnings) {
    if (warning.severity === 'error') {
      hasErrors = true
      console.error(`[${warning.code}] Error: ${warning.message}`)
    } else {
      console.warn(`[${warning.code}] ${warning.message}`)
    }
  }
  return hasErrors
}

/**
 * Persist a lock file to the global lock file.
 * Merges with existing global lock if present, adding/updating entries.
 *
 * WHY: Global mode runs (asp run space:id@selector) need to persist pins
 * to maintain "locked-by-default" behavior even for ad-hoc runs.
 */
async function persistGlobalLock(newLock: LockFile, globalLockPath: string): Promise<void> {
  let existingLock: LockFile | undefined

  // Load existing global lock if it exists
  if (await lockFileExists(globalLockPath)) {
    try {
      existingLock = await readLockJson(globalLockPath)
    } catch {
      // If corrupt, we'll overwrite with new lock
    }
  }

  // Merge with existing lock or use new lock as-is
  const mergedLock: LockFile = existingLock
    ? {
        lockfileVersion: newLock.lockfileVersion,
        resolverVersion: newLock.resolverVersion,
        generatedAt: newLock.generatedAt,
        registry: newLock.registry,
        spaces: { ...existingLock.spaces, ...newLock.spaces },
        targets: { ...existingLock.targets, ...newLock.targets },
      }
    : newLock

  // Write merged lock file
  await writeFile(globalLockPath, serializeLockJson(mergedLock), 'utf-8')
}

/**
 * Run a target with a harness adapter.
 */
export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  const debug = process.env['ASP_DEBUG_RUN'] === '1'
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      console.error('[asp run]', ...args)
    }
  }

  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)

  debugLog('detect harness', harnessId)
  const detection = await adapter.detect()
  debugLog('detect ok', detection.available ? (detection.version ?? 'unknown') : 'unavailable')

  const aspModulesDir = getAspModulesPath(options.projectPath)
  const harnessOutputPath = adapter.getTargetOutputPath(aspModulesDir, targetName)
  debugLog('harness output path', harnessOutputPath)

  const needsInstall =
    options.refresh || !(await harnessOutputExists(options.projectPath, targetName, harnessId))
  if (needsInstall) {
    debugLog('install', options.refresh ? '(refresh)' : '(missing output)')
    await configInstall({
      ...options,
      harness: harnessId,
      targets: [targetName],
      adapter,
    })
    debugLog('install done')
  }

  debugLog('read lock')
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lock = await readLockJson(lockPath)
  debugLog('lock ok')

  const warnings: LintWarning[] = []
  const hasErrors = printWarnings(warnings, options.printWarnings !== false)
  if (hasErrors) {
    throw new Error('Lint errors found - aborting')
  }

  const bundle = await adapter.loadTargetBundle(harnessOutputPath, targetName)

  debugLog('load manifest')
  const manifest = await loadProjectManifest(options.projectPath)
  debugLog('manifest ok')

  const defaults = adapter.getDefaultRunOptions(manifest, targetName)
  const primingPrompt = manifest.targets[targetName]?.priming_prompt
  const effectivePrompt = combinePrompts(defaults.prompt ?? primingPrompt, options.prompt)
  const cliRunOptions: HarnessRunOptions = {
    model: options.model,
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
    emitEvents: options.emitEvents,
    resume: options.resume,
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
  })

  const buildResult: BuildResult = {
    pluginDirs: bundle.pluginDirs ?? [],
    mcpConfigPath: bundle.mcpConfigPath,
    settingsPath: bundle.settingsPath,
    warnings,
    lock,
  }

  return {
    build: buildResult,
    invocation: execution.invocation,
    exitCode: execution.exitCode,
    command: execution.command,
    eventsPath: execution.eventsPath,
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
  /** Harness to run with (default: 'claude') */
  harness?: HarnessId | undefined
  /** Working directory for harness execution */
  cwd?: string | undefined
  /** Whether to run interactively (default: true) */
  interactive?: boolean | undefined
  /** Initial prompt to send to the harness */
  prompt?: string | undefined
  /** Additional harness CLI args */
  extraArgs?: string[] | undefined
  /** Whether to clean up temp dir after run */
  cleanup?: boolean | undefined
  /** Whether to print warnings */
  printWarnings?: boolean | undefined
  /** Additional environment variables */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing the harness */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
  /** Permission mode (--permission-mode flag) */
  permissionMode?: string | undefined
  /** Path to settings JSON file or JSON string (--settings flag) */
  settings?: string | undefined
  /** Force refresh from source (ignored in global/dev mode - always fresh) */
  refresh?: boolean | undefined
  /** YOLO mode - skip all permission prompts (--dangerously-skip-permissions) */
  yolo?: boolean | undefined
  /** Debug mode - enable hook debugging (--debug hooks) */
  debug?: boolean | undefined
  /** Model override (passed through to harness) */
  model?: string | undefined
  /** Inherit project-level settings (for Pi: enables .pi/skills in project) */
  inheritProject?: boolean | undefined
  /** Inherit user-level settings (for Pi: enables ~/.pi/agent/skills) */
  inheritUser?: boolean | undefined
  /** Path to artifact directory for run outputs (events, transcripts) */
  artifactDir?: string | undefined
  /** Whether to emit JSONL events to the artifact directory */
  emitEvents?: boolean | undefined
  /** Resume a previous session (session ID or true for picker) */
  resume?: string | boolean | undefined
}

/**
 * Run a space reference in global mode (without a project).
 *
 * This allows running `asp run space:my-space@stable` without being in a project.
 * The space is resolved from the registry, materialized, and run with the harness.
 *
 * For @dev selector, runs directly from the filesystem (working directory).
 */
export async function runGlobalSpace(
  spaceRefString: SpaceRefString,
  options: GlobalRunOptions = {}
): Promise<RunResult> {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  const detection = await adapter.detect()

  // Parse the space reference
  const ref = parseSpaceRef(spaceRefString)

  // Get registry path
  const registryPath = options.registryPath ?? paths.repo

  // Handle @dev selector - run directly from filesystem
  if (ref.selector.kind === 'dev') {
    const spacePath = join(registryPath, 'spaces', ref.id)
    return runLocalSpace(spacePath, options)
  }

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

  // Persist to global lock file (merge with existing if present)
  await persistGlobalLock(lock, paths.globalLock)

  // Create temp directory for materialization
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, harnessId)
  const artifactRoot = join(tempDir, 'artifacts')
  await ensureDir(outputDir)
  await ensureDir(artifactRoot)

  try {
    const artifacts: ResolvedSpaceArtifact[] = []
    const settingsInputs: SpaceSettings[] = []
    const loadOrder: SpaceKey[] = []
    const rootKeys = new Set(closure.roots)

    for (const spaceKey of closure.loadOrder) {
      const space = closure.spaces.get(spaceKey)
      if (!space) throw new Error(`Space not found in closure: ${spaceKey}`)

      const supports = space.manifest.harness?.supports
      if (!isHarnessSupported(supports, harnessId)) {
        if (rootKeys.has(spaceKey)) {
          throw new Error(`Space "${space.id}" does not support harness "${harnessId}"`)
        }
        continue
      }

      const lockEntry = lock.spaces[spaceKey]
      const pluginName =
        lockEntry?.plugin?.name ?? space.manifest.plugin?.name ?? (space.id as string)
      const pluginVersion = lockEntry?.plugin?.version ?? space.manifest.plugin?.version
      const snapshotIntegrity = lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`
      const snapshotPath = paths.snapshot(snapshotIntegrity)

      const manifest = {
        ...space.manifest,
        schema: 1 as const,
        id: space.id,
        plugin: {
          ...(space.manifest.plugin ?? {}),
          name: pluginName,
          ...(pluginVersion ? { version: pluginVersion } : {}),
        },
      }

      const artifactPath = join(artifactRoot, spaceKey.replace(/[^a-zA-Z0-9._-]/g, '_'))
      await adapter.materializeSpace(
        {
          manifest,
          snapshotPath,
          spaceKey,
          integrity: snapshotIntegrity as `sha256:${string}`,
        },
        artifactPath,
        { force: true, useHardlinks: true }
      )

      artifacts.push({
        spaceKey,
        spaceId: space.id,
        artifactPath,
        pluginName,
        ...(pluginVersion ? { pluginVersion } : {}),
      })

      settingsInputs.push(space.manifest.settings ?? {})
      loadOrder.push(spaceKey)
    }

    const roots = closure.roots.filter((key) => loadOrder.includes(key))
    const composeInput: ComposeTargetInput = {
      targetName: ref.id as string,
      compose: [spaceRefString],
      roots,
      loadOrder,
      artifacts,
      settingsInputs,
    }

    const { bundle } = await adapter.composeTarget(composeInput, outputDir, {
      clean: true,
      inheritProject: options.inheritProject,
      inheritUser: options.inheritUser,
    })

    const cliRunOptions: HarnessRunOptions = {
      model: options.model,
      extraArgs: options.extraArgs,
      interactive: resolveInteractive(options.interactive),
      prompt: options.prompt,
      settingSources: options.settingSources,
      permissionMode: options.permissionMode,
      settings: options.settings,
      yolo: options.yolo,
      debug: options.debug,
      projectPath: options.cwd ?? process.cwd(),
      cwd: options.cwd ?? process.cwd(),
      artifactDir: options.artifactDir,
      emitEvents: options.emitEvents,
      resume: options.resume,
    }
    const runOptions = mergeDefined<HarnessRunOptions>({}, cliRunOptions)

    if (runOptions.interactive === false && runOptions.prompt === undefined) {
      throw new Error('Non-interactive mode requires a prompt')
    }

    const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
      env: options.env,
      dryRun: options.dryRun,
    })

    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

    return {
      build: {
        pluginDirs: bundle.pluginDirs ?? [],
        mcpConfigPath: bundle.mcpConfigPath,
        settingsPath: bundle.settingsPath,
        warnings: [],
        lock,
      },
      invocation: execution.invocation,
      exitCode: execution.exitCode,
      command: execution.command,
      eventsPath: execution.eventsPath,
    }
  } catch (error) {
    await cleanupTempDir(tempDir)
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
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)
  const detection = await adapter.detect()

  // Read the space manifest
  const manifestPath = join(spacePath, 'space.toml')
  const rawManifest = await readSpaceToml(manifestPath)
  const manifest = resolveSpaceManifest(rawManifest)
  const supports = manifest.harness?.supports
  if (!isHarnessSupported(supports, harnessId)) {
    throw new Error(`Space "${manifest.id}" does not support harness "${harnessId}"`)
  }

  // Create temp directory
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, harnessId)
  const artifactRoot = join(tempDir, 'artifacts')
  await ensureDir(outputDir)
  await ensureDir(artifactRoot)

  try {
    const spaceKey = `${manifest.id}@local` as SpaceKey
    const pluginName = manifest.plugin.name
    const pluginVersion = manifest.plugin.version
    const artifactPath = join(artifactRoot, spaceKey.replace(/[^a-zA-Z0-9._-]/g, '_'))

    await adapter.materializeSpace(
      {
        manifest,
        snapshotPath: spacePath,
        spaceKey,
        integrity: 'sha256:dev' as `sha256:${string}`,
      },
      artifactPath,
      { force: true, useHardlinks: false }
    )

    const composeInput: ComposeTargetInput = {
      targetName: manifest.id,
      compose: [`space:${manifest.id}@dev` as SpaceRefString],
      roots: [spaceKey],
      loadOrder: [spaceKey],
      artifacts: [
        {
          spaceKey,
          spaceId: manifest.id,
          artifactPath,
          pluginName,
          ...(pluginVersion ? { pluginVersion } : {}),
        },
      ],
      settingsInputs: [manifest.settings ?? {}],
    }

    const { bundle } = await adapter.composeTarget(composeInput, outputDir, {
      clean: true,
      inheritProject: options.inheritProject,
      inheritUser: options.inheritUser,
    })

    const cliRunOptions: HarnessRunOptions = {
      model: options.model,
      extraArgs: options.extraArgs,
      interactive: resolveInteractive(options.interactive),
      prompt: options.prompt,
      settingSources: options.settingSources,
      permissionMode: options.permissionMode,
      settings: options.settings,
      yolo: options.yolo,
      debug: options.debug,
      projectPath: options.cwd ?? spacePath,
      cwd: options.cwd ?? spacePath,
      artifactDir: options.artifactDir,
      emitEvents: options.emitEvents,
      resume: options.resume,
    }
    const runOptions = mergeDefined<HarnessRunOptions>({}, cliRunOptions)

    if (runOptions.interactive === false && runOptions.prompt === undefined) {
      throw new Error('Non-interactive mode requires a prompt')
    }

    const execution = await executeHarnessRun(adapter, detection, bundle, runOptions, {
      env: options.env,
      dryRun: options.dryRun,
    })

    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

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
        pluginDirs: bundle.pluginDirs ?? [],
        mcpConfigPath: bundle.mcpConfigPath,
        settingsPath: bundle.settingsPath,
        warnings: [],
        lock: syntheticLock,
      },
      invocation: execution.invocation,
      exitCode: execution.exitCode,
      command: execution.command,
      eventsPath: execution.eventsPath,
    }
  } catch (error) {
    await cleanupTempDir(tempDir)
    throw error
  }
}

/**
 * Check if a string is a space reference.
 */
export function isSpaceReference(value: string): value is SpaceRefString {
  return isSpaceRefString(value)
}
