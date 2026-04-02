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
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'

import {
  type AgentRuntimeProfile,
  type ClaudeOptions,
  type CodexOptions,
  type ComposeTargetInput,
  type ComposedTargetBundle,
  DEFAULT_HARNESS,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessId,
  type HarnessRunOptions,
  LOCK_FILENAME,
  type LockFile,
  type ProjectManifest,
  type ResolvedSpaceArtifact,
  type SpaceKey,
  type SpaceRefString,
  type SpaceSettings,
  type TargetDefinition,
  getAspModulesPath,
  getRegistryPath,
  harnessOutputExists,
  isHarnessId,
  isHarnessSupported,
  isSpaceRefString,
  lockFileExists,
  materializeFromRefs,
  mergeAgentWithProjectTarget,
  parseSpaceRef,
  readLockJson,
  readSpaceToml,
  resolveSpaceManifest,
  serializeLockJson,
} from 'spaces-config'

import type { LintWarning } from 'spaces-config'

import { computeClosure, generateLockFileForTarget } from 'spaces-config'

import { PathResolver, copyDir, createSnapshot, ensureDir, getAspHome } from 'spaces-config'

import type { BuildResult } from 'spaces-config'
import { type ResolveOptions, install as configInstall, loadProjectManifest } from 'spaces-config'
import { getAgentsRoot, parseAgentProfile, resolveAgentPrimingPrompt } from 'spaces-config'
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
  /** Codex model reasoning effort override */
  modelReasoningEffort?: string | undefined
  /** Inherit project-level settings (for Pi: enables .pi/skills in project) */
  inheritProject?: boolean | undefined
  /** Inherit user-level settings (for Pi: enables ~/.pi/agent/skills) */
  inheritUser?: boolean | undefined
  /** Path to artifact directory for run outputs (events, transcripts) */
  artifactDir?: string | undefined
  /** Continuation key for resuming a previous session (session ID or true for picker) */
  continuationKey?: string | boolean | undefined
  /** Enable remote control via TCP (--remote-control) */
  remoteControl?: boolean | undefined
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
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function isWithinPath(path: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/')
}

function composeArraysMatch(
  manifestCompose: readonly SpaceRefString[],
  lockCompose: readonly SpaceRefString[]
): boolean {
  if (manifestCompose.length !== lockCompose.length) {
    return false
  }
  return manifestCompose.every((ref, index) => ref === lockCompose[index])
}

function computeCodexRuntimeKey(targetName: string, cwd: string): string {
  return createHash('sha256')
    .update(`codex-runtime-v1\0${targetName}\0${resolve(cwd)}`)
    .digest('hex')
    .slice(0, 24)
}

interface CodexRuntimeMetadata {
  schemaVersion: 1
  harnessId: 'codex'
  mode: 'project' | 'ad-hoc'
  targetName: string
  projectPath?: string | undefined
  cwd?: string | undefined
}

function sanitizeCodexRuntimeSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
  return sanitized || 'default'
}

export function getProjectCodexRuntimeHomePath(
  aspHome: string,
  projectPath: string,
  targetName: string
): string {
  const projectSlug = sanitizeCodexRuntimeSegment(basename(resolve(projectPath)))
  const targetSlug = sanitizeCodexRuntimeSegment(targetName)
  return join(aspHome, 'codex-homes', `${projectSlug}_${targetSlug}`)
}

function getLegacyProjectCodexRuntimeHomePath(projectPath: string, targetName: string): string {
  const aspModulesDir = getAspModulesPath(projectPath)
  return join(aspModulesDir, targetName, 'codex', 'codex.runtime')
}

const CODEX_RUNTIME_METADATA_FILE = '.asp-runtime.json'

async function writeCodexRuntimeMetadata(
  runtimeHome: string,
  metadata: CodexRuntimeMetadata
): Promise<void> {
  await writeFile(
    join(runtimeHome, CODEX_RUNTIME_METADATA_FILE),
    `${JSON.stringify(metadata, null, 2)}\n`
  )
}

function resolveCodexRuntimeHomePath(
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): string {
  if (runOptions.projectPath) {
    const aspModulesDir = getAspModulesPath(runOptions.projectPath)
    if (isWithinPath(bundle.rootDir, aspModulesDir)) {
      const aspHome = runOptions.aspHome ?? getAspHome()
      return getProjectCodexRuntimeHomePath(aspHome, runOptions.projectPath, bundle.targetName)
    }
  }

  const aspHome = runOptions.aspHome ?? getAspHome()
  const cwd = runOptions.cwd ?? runOptions.projectPath ?? process.cwd()
  const key = computeCodexRuntimeKey(bundle.targetName, cwd)
  return join(aspHome, 'codex-homes', key, 'home')
}

function formatTomlProjectKey(projectPath: string): string {
  return `[projects.${JSON.stringify(projectPath)}]`
}

export function ensureCodexProjectTrust(configToml: string, projectPath: string): string {
  const normalizedProjectPath = resolve(projectPath)
  const projectKey = formatTomlProjectKey(normalizedProjectPath)
  if (configToml.includes(projectKey)) {
    return configToml
  }

  const suffix = configToml.endsWith('\n') ? '' : '\n'
  return `${configToml}${suffix}\n${projectKey}\ntrust_level = "trusted"\n`
}

export async function migrateLegacyProjectCodexRuntimeHome(
  aspHome: string,
  projectPath: string,
  targetName: string
): Promise<string> {
  const runtimeHome = getProjectCodexRuntimeHomePath(aspHome, projectPath, targetName)
  const legacyRuntimeHome = getLegacyProjectCodexRuntimeHomePath(projectPath, targetName)

  if (runtimeHome === legacyRuntimeHome) {
    return runtimeHome
  }

  const runtimeExists = await pathExists(runtimeHome)
  const legacyExists = await pathExists(legacyRuntimeHome)
  if (runtimeExists || !legacyExists) {
    return runtimeHome
  }

  await mkdir(dirname(runtimeHome), { recursive: true })
  try {
    await rm(runtimeHome, { recursive: true, force: true })
    await rename(legacyRuntimeHome, runtimeHome)
  } catch {
    await rm(runtimeHome, { recursive: true, force: true })
    await cp(legacyRuntimeHome, runtimeHome, { recursive: true, force: true })
    await rm(legacyRuntimeHome, { recursive: true, force: true })
  }

  return runtimeHome
}

async function syncManagedFile(
  templateHome: string,
  runtimeHome: string,
  relativePath: string
): Promise<void> {
  const srcPath = join(templateHome, relativePath)
  const destPath = join(runtimeHome, relativePath)

  if (!(await pathExists(srcPath))) {
    await rm(destPath, { recursive: true, force: true })
    return
  }

  const srcStat = await lstat(srcPath)
  await rm(destPath, { recursive: true, force: true })

  if (srcStat.isSymbolicLink()) {
    const target = await readlink(srcPath)
    await symlink(target, destPath)
    return
  }

  await copyFile(srcPath, destPath)
}

async function syncManagedDir(
  templateHome: string,
  runtimeHome: string,
  relativePath: string
): Promise<void> {
  const srcPath = join(templateHome, relativePath)
  const destPath = join(runtimeHome, relativePath)

  if (!(await pathExists(srcPath))) {
    await rm(destPath, { recursive: true, force: true })
    return
  }

  await rm(destPath, { recursive: true, force: true })
  await copyDir(srcPath, destPath, { useHardlinks: false })
}

export async function prepareCodexRuntimeHome(
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): Promise<string> {
  const templateHome = bundle.codex?.homeTemplatePath ?? join(bundle.rootDir, 'codex.home')
  const runtimeHome = resolveCodexRuntimeHomePath(bundle, runOptions)
  await mkdir(runtimeHome, { recursive: true })

  await syncManagedFile(templateHome, runtimeHome, 'AGENTS.md')
  await syncManagedFile(templateHome, runtimeHome, 'config.toml')
  await syncManagedFile(templateHome, runtimeHome, 'mcp.json')
  await syncManagedFile(templateHome, runtimeHome, 'manifest.json')
  await syncManagedFile(templateHome, runtimeHome, 'auth.json')
  await syncManagedDir(templateHome, runtimeHome, 'skills')
  await syncManagedDir(templateHome, runtimeHome, 'prompts')

  const configPath = join(runtimeHome, 'config.toml')
  const projectPath = runOptions.cwd ?? runOptions.projectPath
  if (projectPath && (await pathExists(configPath))) {
    const configToml = await readFile(configPath, 'utf-8')
    const trustedConfig = ensureCodexProjectTrust(configToml, projectPath)
    if (trustedConfig !== configToml) {
      await writeFile(configPath, trustedConfig)
    }
  }

  const metadata: CodexRuntimeMetadata = projectPath
    ? {
        schemaVersion: 1,
        harnessId: 'codex',
        mode: 'project',
        targetName: bundle.targetName,
        projectPath: resolve(projectPath),
      }
    : {
        schemaVersion: 1,
        harnessId: 'codex',
        mode: 'ad-hoc',
        targetName: bundle.targetName,
        cwd: resolve(runOptions.cwd ?? process.cwd()),
      }
  await writeCodexRuntimeMetadata(runtimeHome, metadata)

  return runtimeHome
}

async function prepareRunOptions(
  adapter: HarnessAdapter,
  bundle: ComposedTargetBundle,
  runOptions: HarnessRunOptions
): Promise<HarnessRunOptions> {
  if (adapter.id !== 'codex') {
    return runOptions
  }

  const codexHomeDir = await prepareCodexRuntimeHome(bundle, runOptions)
  return { ...runOptions, codexHomeDir }
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
        SHELL: '/bin/bash',
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
  const preparedRunOptions = await prepareRunOptions(adapter, bundle, runOptions)
  const args = adapter.buildRunArgs(bundle, preparedRunOptions)
  const harnessEnv: Record<string, string> = {
    ...(options.env ?? {}),
    ...adapter.getRunEnv(bundle, preparedRunOptions),
  }

  const commandPath = detection.path ?? adapter.id
  const command = formatEnvPrefix(harnessEnv) + formatCommand(commandPath, args)

  if (options.dryRun) {
    return { exitCode: 0, command }
  }

  console.log(`\x1b[90m$ ${command}\x1b[0m`)
  console.log('')

  const { exitCode, stdout, stderr } = await executeHarnessCommand(commandPath, args, {
    interactive: preparedRunOptions.interactive,
    cwd: preparedRunOptions.cwd ?? preparedRunOptions.projectPath,
    env: harnessEnv,
  })

  if (stdout) {
    process.stdout.write(stdout)
  }
  if (stderr) {
    process.stderr.write(stderr)
  }

  return {
    exitCode,
    command,
    invocation:
      preparedRunOptions.interactive === false
        ? {
            exitCode,
            stdout,
            stderr,
          }
        : undefined,
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
 * Agent profile data loaded for asp-run integration.
 */
interface LoadedAgentProfile {
  agentRoot: string
  profile: AgentRuntimeProfile
}

function loadAgentProfileForRun(
  targetName: string,
  options?: { agentsRoot?: string | undefined }
): LoadedAgentProfile | undefined {
  const agentsRoot = options?.agentsRoot ?? getAgentsRoot()
  if (!agentsRoot) {
    return undefined
  }

  const agentRoot = join(agentsRoot, targetName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }
  const profileSource = readFileSync(profilePath, 'utf8').replace(
    /^(\s*)schema_version(\s*=)/m,
    '$1schemaVersion$2'
  )

  return {
    agentRoot,
    profile: parseAgentProfile(profileSource, profilePath),
  }
}

function resolveProfileHarnessForRun(harness: string | undefined): HarnessId | undefined {
  switch (harness) {
    case undefined:
      return undefined
    case 'claude-code':
      return 'claude'
    case 'codex-cli':
      return 'codex'
    case 'agent-sdk':
      return 'claude-agent-sdk'
    default:
      return isHarnessId(harness) ? harness : undefined
  }
}

function resolveAgentPrimingPromptForRun(
  target:
    | {
        priming_prompt?: string | undefined
        priming_prompt_append?: string | undefined
      }
    | undefined,
  agentProfile: LoadedAgentProfile | undefined
): string | undefined {
  if (target?.priming_prompt !== undefined) {
    return target.priming_prompt
  }
  if (!target?.priming_prompt_append) {
    return undefined
  }

  const basePrompt = agentProfile
    ? resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
    : undefined

  if (basePrompt) {
    return `${basePrompt}\n${target.priming_prompt_append}`
  }
  return target.priming_prompt_append
}

function resolveAgentRunDefaultsFromProfile(
  target: TargetDefinition | undefined,
  agentProfile: LoadedAgentProfile
): {
  yolo?: boolean
  model?: string
  harness?: string
  claude?: ClaudeOptions
  codex?: CodexOptions
  compose?: SpaceRefString[]
} {
  const primingPrompt = resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
  const effective = mergeAgentWithProjectTarget(
    {
      ...agentProfile.profile,
      ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
    },
    target,
    'task'
  )

  return {
    yolo: effective.yolo,
    harness: effective.harness,
    claude: effective.claude,
    codex: effective.codex,
    compose: effective.compose,
    ...(effective.model !== undefined ? { model: effective.model } : {}),
  }
}

export function resolveAgentRunDefaults(
  targetName: string,
  target: TargetDefinition | undefined,
  options?: { agentsRoot?: string | undefined }
):
  | {
      yolo?: boolean
      model?: string
      harness?: string
      claude?: ClaudeOptions
      codex?: CodexOptions
      compose?: SpaceRefString[]
    }
  | undefined {
  const agentProfile = loadAgentProfileForRun(targetName, options)
  if (!agentProfile) {
    return undefined
  }
  return resolveAgentRunDefaultsFromProfile(target, agentProfile)
}

function buildSyntheticRunManifest(
  manifest: ProjectManifest,
  targetName: string,
  defaults: NonNullable<ReturnType<typeof resolveAgentRunDefaults>>,
  harnessId: HarnessId,
  primingPrompt: string | undefined
): ProjectManifest {
  const claude: ClaudeOptions = { ...(defaults.claude ?? {}) }
  const codex: CodexOptions = { ...(defaults.codex ?? {}) }

  if (
    (harnessId === 'claude' || harnessId === 'claude-agent-sdk') &&
    defaults.model !== undefined &&
    claude.model === undefined
  ) {
    claude.model = defaults.model
  }
  if (harnessId === 'codex' && defaults.model !== undefined && codex.model === undefined) {
    codex.model = defaults.model
  }

  return {
    schema: 1,
    ...(manifest.claude ? { claude: manifest.claude } : {}),
    ...(manifest.codex ? { codex: manifest.codex } : {}),
    targets: {
      [targetName]: {
        compose: defaults.compose ?? [],
        ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
        ...(defaults.yolo ? { yolo: true } : {}),
        ...(Object.keys(claude).length > 0 ? { claude } : {}),
        ...(Object.keys(codex).length > 0 ? { codex } : {}),
      },
    },
  }
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

  debugLog('load manifest')
  const manifest = await loadProjectManifest(options.projectPath, options.aspHome)
  debugLog('manifest ok')

  const target = manifest.targets[targetName]
  const agentProfile = loadAgentProfileForRun(targetName)
  const agentDefaults = agentProfile
    ? resolveAgentRunDefaultsFromProfile(target, agentProfile)
    : undefined
  const harnessId =
    options.harness ?? resolveProfileHarnessForRun(agentDefaults?.harness) ?? DEFAULT_HARNESS
  const adapter = harnessRegistry.getOrThrow(harnessId)

  debugLog('detect harness', harnessId)
  const detection = await adapter.detect()
  debugLog('detect ok', detection.available ? (detection.version ?? 'unknown') : 'unavailable')

  const aspModulesDir = getAspModulesPath(options.projectPath)
  const harnessOutputPath = adapter.getTargetOutputPath(aspModulesDir, targetName)
  debugLog('harness output path', harnessOutputPath)

  if (adapter.id === 'codex') {
    const aspHome = options.aspHome ?? getAspHome()
    await migrateLegacyProjectCodexRuntimeHome(aspHome, options.projectPath, targetName)
  }

  const lockPath = join(options.projectPath, LOCK_FILENAME)
  const lockExists = await lockFileExists(lockPath)
  const existingLock = lockExists ? await readLockJson(lockPath) : undefined
  const effectiveCompose = agentDefaults?.compose
  const composeChanged =
    effectiveCompose !== undefined &&
    !composeArraysMatch(effectiveCompose, existingLock?.targets[targetName]?.compose ?? [])
  const needsInstall =
    options.refresh ||
    !lockExists ||
    !(await harnessOutputExists(options.projectPath, targetName, harnessId)) ||
    composeChanged
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

  const warnings: LintWarning[] = []
  const hasErrors = printWarnings(warnings, options.printWarnings !== false)
  if (hasErrors) {
    throw new Error('Lint errors found - aborting')
  }

  const bundle = await adapter.loadTargetBundle(harnessOutputPath, targetName)
  const primingPrompt = resolveAgentPrimingPromptForRun(target, agentProfile)
  const effectiveManifest =
    agentDefaults !== undefined
      ? buildSyntheticRunManifest(manifest, targetName, agentDefaults, harnessId, primingPrompt)
      : manifest
  const defaults = adapter.getDefaultRunOptions(effectiveManifest, targetName)

  const effectivePrompt = combinePrompts(defaults.prompt ?? primingPrompt, options.prompt)
  const cliRunOptions: HarnessRunOptions = {
    aspHome: options.aspHome,
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
  /** Codex model reasoning effort override */
  modelReasoningEffort?: string | undefined
  /** Inherit project-level settings (for Pi: enables .pi/skills in project) */
  inheritProject?: boolean | undefined
  /** Inherit user-level settings (for Pi: enables ~/.pi/agent/skills) */
  inheritUser?: boolean | undefined
  /** Path to artifact directory for run outputs (events, transcripts) */
  artifactDir?: string | undefined
  /** Continuation key for resuming a previous session (session ID or true for picker) */
  continuationKey?: string | boolean | undefined
  /** Enable remote control via TCP (--remote-control) */
  remoteControl?: boolean | undefined
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
      aspHome,
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
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
      continuationKey: options.continuationKey,
      remoteControl: options.remoteControl,
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
      aspHome,
      model: options.model,
      modelReasoningEffort: options.modelReasoningEffort,
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
      continuationKey: options.continuationKey,
      remoteControl: options.remoteControl,
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
