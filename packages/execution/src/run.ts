/**
 * Claude launch orchestration (run command).
 *
 * WHY: Orchestrates the full run process:
 * - Ensure target is installed (via asp_modules)
 * - Read materialized plugins from asp_modules
 * - Launch Claude with plugin directories
 * - Emit structured JSONL events for observability
 */

import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import {
  type ComposeTargetInput,
  type ComposedTargetBundle,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessId,
  LOCK_FILENAME,
  type LockFile,
  type ResolvedSpaceArtifact,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  getAspModulesPath,
  getEffectiveClaudeOptions,
  getEffectiveCodexOptions,
  harnessOutputExists,
  isSpaceRefString,
  lockFileExists,
  parseSpaceRef,
  readLockJson,
  readSpaceToml,
  resolveSpaceManifest,
  serializeLockJson,
} from 'spaces-config'

import { type RunEventEmitter, createEventEmitter, getEventsOutputPath } from './events/index.js'

import {
  type ClaudeInvocationResult,
  type ClaudeInvokeOptions,
  type SpawnClaudeOptions,
  detectClaude,
  getClaudeCommand,
  invokeClaude,
  spawnClaude,
} from './claude/index.js'

import { type LintContext, type LintWarning, type SpaceLintData, lintSpaces } from 'spaces-config'

import {
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  materializeSpaces,
} from 'spaces-config'

import { computeClosure, generateLockFileForTarget } from 'spaces-config'

import { PathResolver, createSnapshot, ensureDir, getAspHome } from 'spaces-config'

import type { BuildResult } from 'spaces-config'
import { type ResolveOptions, install as configInstall, loadProjectManifest } from 'spaces-config'
import { harnessRegistry } from './harness/index.js'

function isClaudeCompatibleHarness(harnessId: HarnessId): boolean {
  return harnessId === 'claude' || harnessId === 'claude-agent-sdk'
}

function isHarnessSupported(supports: HarnessId[] | undefined, harnessId: HarnessId): boolean {
  if (!supports) return true
  if (supports.includes(harnessId)) return true
  if (harnessId === 'claude-agent-sdk') return supports.includes('claude')
  if (harnessId === 'pi-sdk') return supports.includes('pi')
  return false
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatCommand(commandPath: string, args: string[]): string {
  return [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
}

async function buildPiBundle(
  outputPath: string,
  targetName: string
): Promise<ComposedTargetBundle> {
  const extensionsDir = join(outputPath, 'extensions')
  const skillsDir = join(outputPath, 'skills')
  const hookBridgePath = join(outputPath, 'asp-hooks.bridge.js')

  let skillsDirPath: string | undefined
  try {
    const entries = await readdir(skillsDir)
    if (entries.length > 0) {
      skillsDirPath = skillsDir
    }
  } catch {
    // No skills directory
  }

  let hookBridge: string | undefined
  try {
    const stats = await stat(hookBridgePath)
    if (stats.isFile()) {
      hookBridge = hookBridgePath
    }
  } catch {
    // No hook bridge
  }

  return {
    harnessId: 'pi',
    targetName,
    rootDir: outputPath,
    pi: {
      extensionsDir,
      skillsDir: skillsDirPath,
      hookBridgePath: hookBridge,
    },
  }
}

async function loadPiSdkBundle(
  outputPath: string,
  targetName: string
): Promise<ComposedTargetBundle> {
  const manifestPath = join(outputPath, 'bundle.json')
  let manifest: { harnessId?: string; schemaVersion?: number } | undefined

  try {
    const raw = await readFile(manifestPath, 'utf-8')
    manifest = JSON.parse(raw) as { harnessId?: string; schemaVersion?: number }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Pi SDK bundle manifest not found: ${manifestPath} (${message})`)
  }

  if (manifest?.harnessId !== 'pi-sdk') {
    throw new Error(`Unexpected Pi SDK bundle harness: ${manifest?.harnessId ?? 'unknown'}`)
  }

  const extensionsDir = join(outputPath, 'extensions')
  const skillsDir = join(outputPath, 'skills')
  const hooksDir = join(outputPath, 'hooks')
  const contextDir = join(outputPath, 'context')

  let skillsDirPath: string | undefined
  try {
    const entries = await readdir(skillsDir)
    if (entries.length > 0) {
      skillsDirPath = skillsDir
    }
  } catch {
    // No skills directory
  }

  let hooksDirPath: string | undefined
  try {
    const entries = await readdir(hooksDir)
    if (entries.length > 0) {
      hooksDirPath = hooksDir
    }
  } catch {
    // No hooks directory
  }

  let contextDirPath: string | undefined
  try {
    const entries = await readdir(contextDir)
    if (entries.length > 0) {
      contextDirPath = contextDir
    }
  } catch {
    // No context directory
  }

  return {
    harnessId: 'pi-sdk',
    targetName,
    rootDir: outputPath,
    piSdk: {
      bundleManifestPath: manifestPath,
      extensionsDir,
      skillsDir: skillsDirPath,
      hooksDir: hooksDirPath,
      contextDir: contextDirPath,
    },
  }
}

async function loadCodexBundle(
  outputPath: string,
  targetName: string
): Promise<ComposedTargetBundle> {
  const codexHome = join(outputPath, 'codex.home')
  const configPath = join(codexHome, 'config.toml')
  const agentsPath = join(codexHome, 'AGENTS.md')
  const skillsDir = join(codexHome, 'skills')
  const promptsDir = join(codexHome, 'prompts')
  const mcpPath = join(codexHome, 'mcp.json')

  const homeStats = await stat(codexHome)
  if (!homeStats.isDirectory()) {
    throw new Error(`Codex home directory not found: ${codexHome}`)
  }

  const configStats = await stat(configPath)
  if (!configStats.isFile()) {
    throw new Error(`Codex config.toml not found: ${configPath}`)
  }

  const agentsStats = await stat(agentsPath)
  if (!agentsStats.isFile()) {
    throw new Error(`Codex AGENTS.md not found: ${agentsPath}`)
  }

  let mcpConfigPath: string | undefined
  try {
    const mcpStats = await stat(mcpPath)
    if (mcpStats.size > 2) {
      mcpConfigPath = mcpPath
    }
  } catch {
    // MCP config is optional
  }

  return {
    harnessId: 'codex',
    targetName,
    rootDir: outputPath,
    pluginDirs: [codexHome],
    mcpConfigPath,
    codex: {
      homeTemplatePath: codexHome,
      configPath,
      agentsPath,
      skillsDir,
      promptsDir,
    },
  }
}

/**
 * Options for run operation.
 */
export interface RunOptions extends ResolveOptions {
  /** Harness to run with (default: 'claude') */
  harness?: HarnessId | undefined
  /** Working directory for Claude (default: projectPath) */
  cwd?: string | undefined
  /** Whether to run interactively (spawn stdio) vs capture output */
  interactive?: boolean | undefined
  /** Prompt to send (non-interactive mode) */
  prompt?: string | undefined
  /** Additional Claude CLI args */
  extraArgs?: string[] | undefined
  /** Whether to print warnings before running (default: true) */
  printWarnings?: boolean | undefined
  /** Additional environment variables to pass to Claude subprocess */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing Claude */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
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
  /** Full Claude command (for dry-run mode) */
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
 * Resolve setting sources value for Claude invocation.
 *
 * @param settingSources - Value from options:
 *   - null: inherit all settings (don't pass --setting-sources)
 *   - undefined: default to isolated mode
 *   - '': isolated mode (pass --setting-sources "")
 *   - 'user,project': specific sources to inherit
 * @returns Value to pass to Claude, or undefined to omit the flag
 */
function resolveSettingSources(settingSources: string | null | undefined): string | undefined {
  // null means "inherit all" - don't pass the flag
  if (settingSources === null) {
    return undefined
  }
  // undefined means use default (isolated)
  if (settingSources === undefined) {
    return ''
  }
  // Otherwise pass the specified value
  return settingSources
}

// ============================================================================
// Claude Execution Helpers
// ============================================================================

/**
 * Result from executing Claude.
 */
interface ClaudeExecutionResult {
  exitCode: number
  invocation?: ClaudeInvocationResult | undefined
  command?: string | undefined
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
 * Execute Claude in either interactive or non-interactive mode.
 */
async function executeClaude(
  invokeOptions: ClaudeInvokeOptions,
  options: {
    interactive?: boolean | undefined
    prompt?: string | undefined
    dryRun?: boolean | undefined
  }
): Promise<ClaudeExecutionResult> {
  // Always compute the command for display/logging
  // Add -p flag for non-interactive mode (with prompt if provided, otherwise just the flag for dry-run)
  const promptArgs = options.prompt
    ? ['-p', options.prompt]
    : options.interactive === false
      ? ['-p']
      : []
  const fullOptions = {
    ...invokeOptions,
    args: [...(invokeOptions.args ?? []), ...promptArgs],
  }
  const baseCommand = await getClaudeCommand(fullOptions)
  // Prepend env vars in shell syntax for copy-paste compatibility
  const command = formatEnvPrefix(invokeOptions.env) + baseCommand

  // In dry-run mode, just return the command without executing
  if (options.dryRun) {
    return { exitCode: 0, command }
  }

  // Print the command before executing
  console.log(`\x1b[90m$ ${command}\x1b[0m`)
  console.log('')

  if (options.interactive !== false) {
    // Interactive mode - spawn with inherited stdio
    const spawnOptions: SpawnClaudeOptions = { ...invokeOptions, inheritStdio: true }
    const { proc } = await spawnClaude(spawnOptions)
    const exitCode = await proc.exited
    return { exitCode, command }
  }

  // Non-interactive mode - capture output
  const invocation = await invokeClaude({
    ...invokeOptions,
    args: [...(invokeOptions.args ?? []), ...promptArgs],
    captureOutput: true,
  })
  return { exitCode: invocation.exitCode, invocation, command }
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

async function executeNonClaudeHarness(
  adapter: HarnessAdapter,
  detection: HarnessDetection,
  bundle: ComposedTargetBundle,
  harnessId: HarnessId,
  options: {
    cwd?: string | undefined
    env?: Record<string, string> | undefined
    extraArgs?: string[] | undefined
    model?: string | undefined
    prompt?: string | undefined
    interactive?: boolean | undefined
    yolo?: boolean | undefined
    artifactDir?: string | undefined
    emitEvents?: boolean | undefined
    dryRun?: boolean | undefined
    projectPath?: string | undefined
  }
): Promise<{ exitCode: number; command?: string; eventsPath?: string }> {
  const artifactDir = options.artifactDir
  const eventsPath =
    options.emitEvents && artifactDir ? getEventsOutputPath(artifactDir) : undefined

  let eventEmitter: RunEventEmitter | undefined
  if (eventsPath) {
    eventEmitter = await createEventEmitter({
      outputPath: eventsPath,
      heartbeatIntervalMs: 30000,
    })
  }

  const isCodex = harnessId === 'codex'
  const args = adapter.buildRunArgs(bundle, {
    model: options.model,
    approvalPolicy: isCodex ? (options.yolo ? 'never' : undefined) : undefined,
    sandboxMode: isCodex ? (options.yolo ? 'danger-full-access' : undefined) : undefined,
    extraArgs: options.extraArgs,
    projectPath: options.projectPath,
    prompt: options.prompt,
    interactive: options.interactive,
    cwd: options.cwd,
    yolo: options.yolo,
    artifactDir,
    emitEvents: options.emitEvents,
  })

  const harnessEnv: Record<string, string> = {
    ...options.env,
  }
  if (harnessId === 'pi' || harnessId === 'pi-sdk') {
    harnessEnv['PI_CODING_AGENT_DIR'] = bundle.rootDir
  }
  if (harnessId === 'codex') {
    const codexHome = bundle.codex?.homeTemplatePath ?? join(bundle.rootDir, 'codex.home')
    harnessEnv['CODEX_HOME'] = codexHome
  }

  const commandPath = detection.path ?? harnessId
  const command = formatEnvPrefix(harnessEnv) + formatCommand(commandPath, args)

  if (options.dryRun) {
    if (eventEmitter) await eventEmitter.close()
    return { exitCode: 0, command, ...(eventsPath ? { eventsPath } : {}) }
  }

  eventEmitter?.emitJobStarted({
    harness: harnessId,
    target: bundle.targetName,
    pid: process.pid,
    cwd: options.cwd ?? process.cwd(),
  })

  console.log(`\x1b[90m$ ${command}\x1b[0m`)
  console.log('')

  const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
    interactive: options.interactive,
    cwd: options.cwd,
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

  return { exitCode, command, ...(eventsPath ? { eventsPath } : {}) }
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
 * Get plugin directories from asp_modules/<target>/<harness>/plugins/.
 * Returns directories sorted alphabetically to respect numeric prefixes (e.g., "000-base", "001-frontend").
 */
async function getPluginDirsFromAspModules(harnessOutputPath: string): Promise<string[]> {
  const pluginsPath = join(harnessOutputPath, 'plugins')
  const entries = await readdir(pluginsPath, { withFileTypes: true })

  const pluginDirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      pluginDirs.push(join(pluginsPath, entry.name))
    }
  }

  // Sort alphabetically to respect numeric prefixes that preserve load order
  return pluginDirs.sort()
}

/**
 * Run a target with Claude.
 *
 * This:
 * 1. Detects Claude installation
 * 2. Ensures target is installed (asp_modules/<target>/<harness>/ exists)
 * 3. Reads plugin directories from asp_modules
 * 4. Launches Claude with plugin directories
 */
export async function run(targetName: string, options: RunOptions): Promise<RunResult> {
  const debug = process.env['ASP_DEBUG_RUN'] === '1'
  const debugLog = (...args: unknown[]) => {
    if (debug) {
      console.error('[asp run]', ...args)
    }
  }

  // Determine artifact directory and events path
  const artifactDir = options.artifactDir
  const eventsPath =
    options.emitEvents && artifactDir ? getEventsOutputPath(artifactDir) : undefined

  // Create event emitter if configured
  let eventEmitter: RunEventEmitter | undefined
  if (eventsPath) {
    debugLog('events path', eventsPath)
    eventEmitter = await createEventEmitter({
      outputPath: eventsPath,
      heartbeatIntervalMs: 30000, // 30 second heartbeats
    })
  }

  // Get harness adapter (default to claude)
  const harnessId = options.harness ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)

  // Detect harness (throws if not installed)
  debugLog('detect harness', harnessId)
  const detection = await adapter.detect()
  debugLog('detect ok', detection.available ? (detection.version ?? 'unknown') : 'unavailable')

  // Get harness-aware output paths
  const aspModulesDir = getAspModulesPath(options.projectPath)
  const harnessOutputPath = adapter.getTargetOutputPath(aspModulesDir, targetName)
  debugLog('harness output path', harnessOutputPath)

  // Check if target is installed for this harness, if not run install
  // Also run install if refresh is requested
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

  // Load lock file to get warnings and metadata
  debugLog('read lock')
  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lock = await readLockJson(lockPath)
  debugLog('lock ok')

  // Run lint checks
  // TODO: Consider caching lint results in asp_modules
  const warnings: LintWarning[] = []

  // Print warnings if requested, halt on errors
  const hasErrors = printWarnings(warnings, options.printWarnings !== false)
  if (hasErrors) {
    throw new Error('Lint errors found - aborting')
  }

  if (!isClaudeCompatibleHarness(harnessId)) {
    debugLog('non-claude harness', harnessId)
    const codexOptions =
      harnessId === 'codex'
        ? getEffectiveCodexOptions(await loadProjectManifest(options.projectPath), targetName)
        : undefined
    const bundle =
      harnessId === 'pi'
        ? await buildPiBundle(harnessOutputPath, targetName)
        : harnessId === 'pi-sdk'
          ? await loadPiSdkBundle(harnessOutputPath, targetName)
          : harnessId === 'codex'
            ? await loadCodexBundle(harnessOutputPath, targetName)
            : (() => {
                throw new Error(`Unsupported harness: ${harnessId}`)
              })()

    const isCodex = harnessId === 'codex'
    const codexModel = isCodex ? (options.model ?? codexOptions?.model) : options.model
    const codexApprovalPolicy = isCodex
      ? options.yolo
        ? 'never'
        : codexOptions?.approval_policy
      : undefined
    const codexSandboxMode = isCodex
      ? options.yolo
        ? 'danger-full-access'
        : codexOptions?.sandbox_mode
      : undefined
    const codexProfile = isCodex ? codexOptions?.profile : undefined

    const args = adapter.buildRunArgs(bundle, {
      model: codexModel,
      approvalPolicy: codexApprovalPolicy,
      sandboxMode: codexSandboxMode,
      profile: codexProfile,
      extraArgs: options.extraArgs,
      projectPath: options.projectPath,
      prompt: options.prompt,
      interactive: options.interactive,
      settingSources: options.settingSources,
      cwd: options.cwd ?? options.projectPath,
      yolo: options.yolo,
      artifactDir,
      emitEvents: options.emitEvents,
    })

    // Build env vars for harness execution.
    const harnessEnv: Record<string, string> = {
      ...options.env,
    }
    if (harnessId === 'pi' || harnessId === 'pi-sdk') {
      harnessEnv['PI_CODING_AGENT_DIR'] = harnessOutputPath
    }
    if (harnessId === 'codex') {
      const codexHome = bundle.codex?.homeTemplatePath ?? join(harnessOutputPath, 'codex.home')
      harnessEnv['CODEX_HOME'] = codexHome
    }

    const commandPath = detection.path ?? harnessId
    // Include env prefix in command for copy-paste compatibility
    const command = formatEnvPrefix(harnessEnv) + formatCommand(commandPath, args)

    if (options.dryRun) {
      debugLog('dry run non-claude')
      if (eventEmitter) await eventEmitter.close()
      return {
        build: {
          pluginDirs: [],
          warnings,
          lock,
        },
        exitCode: 0,
        command,
        eventsPath,
      }
    }

    // Emit job_started event
    eventEmitter?.emitJobStarted({
      harness: harnessId,
      target: targetName,
      pid: process.pid,
      cwd: options.cwd ?? options.projectPath,
    })

    // Print the command before executing
    console.log(`\x1b[90m$ ${command}\x1b[0m`)
    console.log('')

    const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
      interactive: options.interactive,
      cwd: options.cwd ?? options.projectPath,
      env: harnessEnv,
    })

    // Print captured output for non-interactive mode
    if (stdout) {
      process.stdout.write(stdout)
    }
    if (stderr) {
      process.stderr.write(stderr)
    }

    // Emit job_completed event
    eventEmitter?.emitJobCompleted({
      exitCode,
      outcome: exitCode === 0 ? 'success' : 'failure',
    })
    if (eventEmitter) await eventEmitter.close()

    debugLog('non-claude exit', exitCode)

    return {
      build: {
        pluginDirs: [],
        warnings,
        lock,
      },
      exitCode,
      command,
      eventsPath,
    }
  }

  // Get paths from asp_modules/<target>/<harness>/
  debugLog('collect plugin dirs')
  const pluginDirs = await getPluginDirsFromAspModules(harnessOutputPath)
  debugLog('plugin dirs', pluginDirs.length)
  const mcpConfigPath = join(harnessOutputPath, 'mcp.json')
  const settingsPath = join(harnessOutputPath, 'settings.json')

  // Check if MCP config exists and has content
  let mcpConfig: string | undefined
  try {
    const mcpStats = await stat(mcpConfigPath)
    if (mcpStats.size > 2) {
      // More than just "{}"
      mcpConfig = mcpConfigPath
    }
  } catch {
    // MCP config doesn't exist, that's fine
  }
  debugLog('mcp', mcpConfig ?? 'none')

  // Load project manifest to get claude options and target config
  debugLog('load manifest')
  const manifest = await loadProjectManifest(options.projectPath)
  const claudeOptions = getEffectiveClaudeOptions(manifest, targetName)
  const target = manifest.targets[targetName]
  debugLog('manifest ok')

  // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
  const settingSources = resolveSettingSources(options.settingSources)
  debugLog('setting sources', settingSources ?? 'inherit-all')

  // Build Claude invocation options
  // Use settings from options if provided, otherwise use composed settings from asp_modules
  // yolo: CLI option overrides target config
  const effectiveYolo = options.yolo ?? target?.yolo ?? false
  const yoloArgs = effectiveYolo ? ['--dangerously-skip-permissions'] : []
  const invokeOptions: ClaudeInvokeOptions = {
    pluginDirs,
    mcpConfig,
    model: options.model ?? claudeOptions.model,
    permissionMode: claudeOptions.permission_mode,
    settingSources,
    settings: options.settings ?? settingsPath,
    debug: options.debug,
    cwd: options.cwd ?? options.projectPath,
    args: [...(claudeOptions.args ?? []), ...yoloArgs, ...(options.extraArgs ?? [])],
    env: {
      ...options.env,
      ASP_PLUGIN_ROOT: harnessOutputPath,
    },
  }
  debugLog('run options', {
    prompt: options.prompt,
    interactive: options.interactive,
    dryRun: options.dryRun,
  })

  // Handle dry-run mode
  if (options.dryRun) {
    debugLog('dry run claude')
    if (eventEmitter) await eventEmitter.close()
  }

  // Emit job_started event
  eventEmitter?.emitJobStarted({
    harness: harnessId,
    target: targetName,
    pid: process.pid,
    cwd: options.cwd ?? options.projectPath,
  })

  debugLog('invoke claude')

  // Execute Claude
  const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)
  debugLog('invoke done', exitCode)

  // Emit job_completed event
  eventEmitter?.emitJobCompleted({
    exitCode,
    outcome: exitCode === 0 ? 'success' : 'failure',
  })
  if (eventEmitter) await eventEmitter.close()

  // Build a BuildResult-compatible object for the return value
  const buildResult: BuildResult = {
    pluginDirs,
    mcpConfigPath: mcpConfig,
    settingsPath,
    warnings,
    lock,
  }

  return {
    build: buildResult,
    invocation,
    exitCode,
    command,
    eventsPath,
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
  /** Working directory for Claude */
  cwd?: string | undefined
  /** Whether to run interactively (default: true) */
  interactive?: boolean | undefined
  /** Prompt for non-interactive mode */
  prompt?: string | undefined
  /** Additional Claude CLI args */
  extraArgs?: string[] | undefined
  /** Whether to clean up temp dir after run */
  cleanup?: boolean | undefined
  /** Whether to print warnings */
  printWarnings?: boolean | undefined
  /** Additional environment variables */
  env?: Record<string, string> | undefined
  /** Dry run mode - print command without executing Claude */
  dryRun?: boolean | undefined
  /** Setting sources for Claude: null = inherit all, undefined = default (isolated), '' = isolated, string = specific sources */
  settingSources?: string | null | undefined
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
}

/**
 * Run a space reference in global mode (without a project).
 *
 * This allows running `asp run space:my-space@stable` without being in a project.
 * The space is resolved from the registry, materialized, and run with Claude.
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

  if (!isClaudeCompatibleHarness(harnessId)) {
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

      const warnings: LintWarning[] = []
      const result = await executeNonClaudeHarness(adapter, detection, bundle, harnessId, {
        cwd: options.cwd ?? process.cwd(),
        projectPath: options.cwd ?? process.cwd(),
        env: options.env,
        extraArgs: options.extraArgs,
        model: options.model,
        prompt: options.prompt,
        interactive: options.interactive,
        yolo: options.yolo,
        artifactDir: options.artifactDir,
        emitEvents: options.emitEvents,
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
          warnings,
          lock,
        },
        exitCode: result.exitCode,
        command: result.command,
        eventsPath: result.eventsPath,
      }
    } catch (error) {
      await cleanupTempDir(tempDir)
      throw error
    }
  }

  // Detect Claude
  await detectClaude()

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
  const outputDir = join(tempDir, 'plugins')
  await ensureDir(outputDir)

  try {
    // Build materialization inputs from closure
    const inputs = closure.loadOrder.map((key) => {
      const space = closure.spaces.get(key)
      if (!space) throw new Error(`Space not found in closure: ${key}`)
      const lockEntry = lock.spaces[key]
      return {
        manifest: {
          schema: 1 as const,
          id: space.id,
          plugin: lockEntry?.plugin ?? { name: space.manifest.plugin?.name ?? space.id },
        },
        snapshotPath: paths.snapshot(lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`),
        spaceKey: key,
        integrity: lockEntry?.integrity ?? `sha256:${'0'.repeat(64)}`,
      }
    })

    // Materialize all spaces
    const materializeResults = await materializeSpaces(inputs, { paths })
    const pluginDirs = materializeResults.map((r) => r.pluginPath)

    // Compose MCP configuration
    let mcpConfigPath: string | undefined
    const mcpOutputPath = join(outputDir, 'mcp.json')
    const spacesDirs = materializeResults.map((r) => ({
      spaceId: r.spaceKey.split('@')[0] ?? r.spaceKey,
      dir: r.pluginPath,
    }))
    const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
    if (Object.keys(mcpResult.config.mcpServers).length > 0) {
      mcpConfigPath = mcpOutputPath
    }

    // Compose settings from all spaces in the closure
    const settingsOutputPath = join(outputDir, 'settings.json')
    const settingsInputs: SettingsInput[] = []
    for (const key of closure.loadOrder) {
      const space = closure.spaces.get(key)
      if (space?.manifest.settings) {
        settingsInputs.push({
          spaceId: space.id as string,
          settings: space.manifest.settings,
        })
      }
    }

    await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
    const settingsPath = settingsOutputPath

    // Run lint checks
    let warnings: LintWarning[] = []
    const lintData: SpaceLintData[] = closure.loadOrder.map((key, i) => {
      const space = closure.spaces.get(key)
      if (!space) throw new Error(`Space not found in closure: ${key}`)
      return {
        key,
        manifest: space.manifest,
        pluginPath: pluginDirs[i] ?? '',
      }
    })
    const lintContext: LintContext = { spaces: lintData }
    warnings = await lintSpaces(lintContext)
    const hasGlobalErrors = printWarnings(warnings, options.printWarnings !== false)
    if (hasGlobalErrors) {
      throw new Error('Lint errors found - aborting')
    }

    // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
    const settingSources = resolveSettingSources(options.settingSources)

    // Build Claude invocation options
    // Use settings from options if provided, otherwise use composed settings
    // ASP_PLUGIN_ROOT points to the first plugin dir (for single-space @dev runs)
    const yoloArgs = options.yolo ? ['--dangerously-skip-permissions'] : []
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      model: options.model,
      settingSources,
      settings: options.settings ?? settingsPath,
      debug: options.debug,
      cwd: options.cwd ?? process.cwd(),
      args: [...yoloArgs, ...(options.extraArgs ?? [])],
      env: {
        ...options.env,
        ASP_PLUGIN_ROOT: pluginDirs[0] ?? tempDir,
      },
    }

    // Execute Claude
    const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)

    // Cleanup (always for dry-run)
    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

    return {
      build: {
        pluginDirs,
        mcpConfigPath,
        settingsPath,
        warnings,
        lock,
      },
      invocation,
      exitCode,
      command,
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
  const paths = new PathResolver({ aspHome })
  const harnessId = options.harness ?? DEFAULT_HARNESS

  if (!isClaudeCompatibleHarness(harnessId)) {
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

      const warnings: LintWarning[] = []
      const result = await executeNonClaudeHarness(adapter, detection, bundle, harnessId, {
        cwd: options.cwd ?? spacePath,
        projectPath: options.cwd ?? spacePath,
        env: options.env,
        extraArgs: options.extraArgs,
        model: options.model,
        prompt: options.prompt,
        interactive: options.interactive,
        yolo: options.yolo,
        artifactDir: options.artifactDir,
        emitEvents: options.emitEvents,
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
          warnings,
          lock: syntheticLock,
        },
        exitCode: result.exitCode,
        command: result.command,
        eventsPath: result.eventsPath,
      }
    } catch (error) {
      await cleanupTempDir(tempDir)
      throw error
    }
  }

  // Detect Claude
  await detectClaude()

  // Read the space manifest
  const manifestPath = join(spacePath, 'space.toml')
  const manifest = await readSpaceToml(manifestPath)

  // Create temp directory
  const tempDir = await createTempDir(aspHome)
  const outputDir = join(tempDir, 'plugins')
  await ensureDir(outputDir)

  try {
    // For local dev mode, we materialize directly from the source path
    // Create a synthetic space key
    const spaceKey = `${manifest.id}@local` as SpaceKey

    // Build input for materialization
    // Use 'sha256:dev' to signal the materializer to skip caching
    const inputs = [
      {
        manifest,
        snapshotPath: spacePath, // Use local path directly
        spaceKey,
        integrity: 'sha256:dev' as `sha256:${string}`,
      },
    ]

    // Materialize (this will copy from the local path)
    const materializeResults = await materializeSpaces(inputs, { paths })
    const pluginDirs = materializeResults.map((r) => r.pluginPath)

    // Compose MCP configuration
    let mcpConfigPath: string | undefined
    const mcpOutputPath = join(outputDir, 'mcp.json')
    const spacesDirs = materializeResults.map((r) => ({
      spaceId: manifest.id,
      dir: r.pluginPath,
    }))
    const mcpResult = await composeMcpFromSpaces(spacesDirs, mcpOutputPath)
    if (Object.keys(mcpResult.config.mcpServers).length > 0) {
      mcpConfigPath = mcpOutputPath
    }

    // Compose settings from the local space
    const settingsOutputPath = join(outputDir, 'settings.json')
    const settingsInputs: SettingsInput[] = manifest.settings
      ? [{ spaceId: manifest.id, settings: manifest.settings }]
      : []
    await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)
    const settingsPath = settingsOutputPath

    // Run lint checks
    let warnings: LintWarning[] = []
    const lintData: SpaceLintData[] = [
      {
        key: spaceKey,
        manifest,
        pluginPath: pluginDirs[0] ?? '',
      },
    ]
    const lintContext: LintContext = { spaces: lintData }
    warnings = await lintSpaces(lintContext)
    const hasLocalErrors = printWarnings(warnings, options.printWarnings !== false)
    if (hasLocalErrors) {
      throw new Error('Lint errors found - aborting')
    }

    // Resolve setting sources (null = inherit all, undefined = isolated, string = specific)
    const settingSources = resolveSettingSources(options.settingSources)

    // Build Claude invocation options
    // Use settings from options if provided, otherwise use composed settings
    // ASP_PLUGIN_ROOT points to the first plugin dir (for single-space @dev runs)
    // Default cwd to spacePath so local dev mode runs in the space directory
    const yoloArgs = options.yolo ? ['--dangerously-skip-permissions'] : []
    const invokeOptions: ClaudeInvokeOptions = {
      pluginDirs,
      mcpConfig: mcpConfigPath,
      model: options.model,
      settingSources,
      settings: options.settings ?? settingsPath,
      debug: options.debug,
      cwd: options.cwd ?? spacePath,
      args: [...yoloArgs, ...(options.extraArgs ?? [])],
      env: {
        ...options.env,
        ASP_PLUGIN_ROOT: pluginDirs[0] ?? tempDir,
      },
    }

    // Execute Claude
    const { exitCode, invocation, command } = await executeClaude(invokeOptions, options)

    // Cleanup (always for dry-run)
    const shouldCleanup = options.dryRun ? false : (options.cleanup ?? !options.interactive)
    if (shouldCleanup) {
      await cleanupTempDir(tempDir)
    }

    // Create a synthetic lock for the result
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
        pluginDirs,
        mcpConfigPath,
        settingsPath,
        warnings,
        lock: syntheticLock,
      },
      invocation,
      exitCode,
      command,
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
