/**
 * PiSdkAdapter - Harness adapter for Pi SDK
 *
 * Implements the HarnessAdapter interface for Pi SDK, supporting:
 * - Extension bundling with Bun
 * - Skills directory handling (Agent Skills standard)
 * - Hook script materialization and bundle manifest generation
 * - SDK-backed runner invocation
 */

import { readdirSync } from 'node:fs'
import {
  constants,
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  AspError,
  type ComposeTargetInput,
  type ComposeTargetOptions,
  type ComposeTargetResult,
  type ComposedTargetBundle,
  type HarnessAdapter,
  type HarnessDetection,
  type HarnessModelInfo,
  type HarnessRunOptions,
  type HarnessValidationResult,
  type LockWarning,
  type MaterializeSpaceInput,
  type MaterializeSpaceOptions,
  type MaterializeSpaceResult,
  type ProjectManifest,
  copyDir,
  linkOrCopy,
} from 'spaces-config'
import {
  INSTRUCTIONS_FILE_AGNOSTIC,
  INSTRUCTIONS_FILE_CLAUDE,
  readHooksWithPrecedence,
} from 'spaces-config'
import type {
  PiSdkBundleContextEntry,
  PiSdkBundleExtensionEntry,
  PiSdkBundleHookEntry,
  PiSdkBundleManifest as PiSdkBundleManifestShape,
} from '../pi-session/bundle-manifest-types.js'
import { resolveSdkEntry } from '../pi-session/sdk-entry.js'
import {
  type ExtensionBuildOptions,
  PiBundleError,
  bundleExtension,
  discoverExtensions,
} from './pi-bundle.js'

// ============================================================================
// Constants & Types
// ============================================================================

const DEFAULT_PI_SDK_MODEL = 'openai-codex/gpt-5.5'

const RUNNER_PATH = fileURLToPath(new URL('../pi-sdk/pi-sdk/runner.js', import.meta.url))

/**
 * Producer-side view of the canonical bundle manifest. The adapter writes a
 * stricter literal than the canonical (consumer) shape tolerates — `schemaVersion`
 * is always `1`, `harnessId` is always `'pi-sdk'`, and `contextFiles`/`hooks` are
 * always materialized — so it narrows the shared `PiSdkBundleManifestShape`
 * rather than re-declaring the interface family. This keeps producer and
 * consumer pinned to a single source of truth (bundle-manifest-types.ts).
 */
type PiSdkBundleManifest = PiSdkBundleManifestShape & {
  schemaVersion: 1
  harnessId: 'pi-sdk'
  contextFiles: PiSdkBundleContextEntry[]
  hooks: PiSdkBundleHookEntry[]
}

/** The optional `pi.build` extension of a project manifest (see {@link ExtensionBuildOptions}). */
interface PiManifestExtension {
  pi?: {
    build?: ExtensionBuildOptions
  }
}

// ============================================================================
// Helper utilities
// ============================================================================

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/** Copy `src` to `dest` when `src` is an existing directory; returns whether it did. */
async function copyDirIfPresent(src: string, dest: string): Promise<boolean> {
  if (!(await isDirectory(src))) {
    return false
  }
  await copyDir(src, dest)
  return true
}

/** Whether `dir` exists and contains at least one entry. */
async function dirHasEntries(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir)
    return entries.length > 0
  } catch {
    return false
  }
}

function normalizeBundlePath(path: string): string {
  return path.replaceAll('\\', '/')
}

async function resolveInstructionFile(snapshotPath: string): Promise<string | null> {
  const agentPath = join(snapshotPath, INSTRUCTIONS_FILE_AGNOSTIC)
  if (await fileExists(agentPath)) {
    return agentPath
  }

  const claudePath = join(snapshotPath, INSTRUCTIONS_FILE_CLAUDE)
  if (await fileExists(claudePath)) {
    return claudePath
  }

  return null
}

async function resolveHookScriptRelative(script: string, hooksDir: string): Promise<string> {
  const normalized = script.replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '').replace(/^hooks\//, '')

  if (/\s/.test(normalized)) {
    return script
  }

  if (isAbsolute(normalized)) {
    if (await isFile(normalized)) {
      return normalized
    }
    throw new AspError(`Hook script not found: "${script}"`, 'HOOK_SCRIPT_NOT_FOUND')
  }

  const directPath = join(hooksDir, normalized)
  if (await isFile(directPath)) {
    return normalized
  }

  if (!normalized.startsWith('scripts/')) {
    const scriptsPath = join(hooksDir, 'scripts', normalized)
    if (await isFile(scriptsPath)) {
      return normalizeBundlePath(join('scripts', normalized))
    }
  }

  if (!normalized.includes('/') && !normalized.includes('\\')) {
    return script
  }

  throw new AspError(
    `Hook script not found: "${script}" (tried "${directPath}")`,
    'HOOK_SCRIPT_NOT_FOUND'
  )
}

// ============================================================================
// PiSdkAdapter Implementation
// ============================================================================

export class PiSdkAdapter implements HarnessAdapter {
  readonly id = 'pi-sdk' as const
  readonly name = 'Pi SDK'

  readonly models: HarnessModelInfo[] = [
    { id: DEFAULT_PI_SDK_MODEL, name: 'GPT-5.5', default: true },
    { id: 'openai-codex/gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    { id: 'openai-codex/gpt-5.3', name: 'GPT-5.3' },
    { id: 'openai-codex/gpt-5.2-codex', name: 'GPT-5.2 Codex' },
    { id: 'openai-codex/gpt-5.2', name: 'GPT-5.2' },
    { id: 'openai-codex/gpt-5.1', name: 'GPT-5.1' },
    { id: 'openai-codex/gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max' },
    { id: 'openai-codex/gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini' },
  ]

  async detect(): Promise<HarnessDetection> {
    const sdkRoot = process.env['ASP_PI_SDK_ROOT']
    if (sdkRoot) {
      const entry = await resolveSdkEntry(sdkRoot)
      if (!entry) {
        return {
          available: false,
          error: `Pi SDK not found under ASP_PI_SDK_ROOT (${sdkRoot})`,
        }
      }

      return {
        available: true,
        version: 'dev',
        path: 'bun',
        capabilities: ['sdk'],
      }
    }

    try {
      await import('@mariozechner/pi-coding-agent')
      return {
        available: true,
        version: 'unknown',
        path: 'bun',
        capabilities: ['sdk'],
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  validateSpace(_input: MaterializeSpaceInput): HarnessValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    }
  }

  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []

    try {
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      await this.materializeExtensions(input, cacheDir, files, warnings)
      await this.materializeSkills(input, cacheDir, files)
      await this.materializeHooks(input, cacheDir, files)
      await this.materializeContext(input, cacheDir, files)

      return {
        artifactPath: cacheDir,
        files,
        warnings,
      }
    } catch (err) {
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  private async materializeExtensions(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[],
    warnings: string[]
  ): Promise<void> {
    const manifestWithPi = input.manifest as typeof input.manifest & PiManifestExtension
    const buildOpts: ExtensionBuildOptions = {
      format: manifestWithPi.pi?.build?.format,
      target: manifestWithPi.pi?.build?.target,
      external: manifestWithPi.pi?.build?.external,
    }

    const extensionsDir = join(cacheDir, 'extensions')
    await mkdir(extensionsDir, { recursive: true })

    const sourceExtensions = await discoverExtensions(input.snapshotPath)
    const spaceId = input.manifest.id

    for (const srcPath of sourceExtensions) {
      const srcBasename = basename(srcPath)
      const srcName = srcBasename.replace(/\.(ts|js)$/, '')
      const outName = `${spaceId}__${srcName}.js`
      const outPath = join(extensionsDir, outName)

      try {
        await bundleExtension(srcPath, outPath, buildOpts)
        files.push(`extensions/${outName}`)
      } catch (err) {
        if (err instanceof PiBundleError) {
          warnings.push(`Failed to bundle ${srcBasename}: ${err.stderr}`)
        } else {
          throw err
        }
      }
    }
  }

  private async materializeSkills(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[]
  ): Promise<void> {
    const srcSkillsDir = join(input.snapshotPath, 'skills')
    const destSkillsDir = join(cacheDir, 'skills')
    if (await copyDirIfPresent(srcSkillsDir, destSkillsDir)) {
      const skillEntries = await readdir(destSkillsDir)
      for (const entry of skillEntries) {
        files.push(`skills/${entry}`)
      }
    }
  }

  private async materializeHooks(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[]
  ): Promise<void> {
    const srcHooksDir = join(input.snapshotPath, 'hooks')
    const destHooksDir = join(cacheDir, 'hooks')
    if (await copyDirIfPresent(srcHooksDir, destHooksDir)) {
      const hookEntries = await readdir(destHooksDir)
      for (const entry of hookEntries) {
        files.push(`hooks/${entry}`)
      }
    }
  }

  private async materializeContext(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[]
  ): Promise<void> {
    const contextDir = join(cacheDir, 'context')
    const instructionPath = await resolveInstructionFile(input.snapshotPath)
    if (instructionPath) {
      await mkdir(contextDir, { recursive: true })
      const contextName = `${input.manifest.id}.md`
      const destPath = join(contextDir, contextName)
      await linkOrCopy(instructionPath, destPath)
      files.push(`context/${contextName}`)
    }
  }

  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const warnings: LockWarning[] = []

    if (options.clean) {
      await rm(outputDir, { recursive: true, force: true })
    }
    await mkdir(outputDir, { recursive: true })

    const extensionsDir = join(outputDir, 'extensions')
    const skillsDir = join(outputDir, 'skills')
    const hooksDir = join(outputDir, 'hooks')
    const contextDir = join(outputDir, 'context')

    await mkdir(extensionsDir, { recursive: true })
    await mkdir(skillsDir, { recursive: true })
    await mkdir(hooksDir, { recursive: true })
    await mkdir(contextDir, { recursive: true })

    const extensions: PiSdkBundleExtensionEntry[] = []
    const contextFiles: PiSdkBundleContextEntry[] = []
    const hooks: PiSdkBundleHookEntry[] = []

    for (const artifact of input.artifacts) {
      await this.mergeArtifactExtensions(artifact, extensionsDir, extensions)
      await this.mergeArtifactSkills(artifact, skillsDir)
      await this.mergeArtifactHooks(artifact, hooksDir, hooks)
      await this.mergeArtifactContext(artifact, contextDir, contextFiles)
    }

    const hasSkills = await dirHasEntries(skillsDir)
    const hasHooks = await dirHasEntries(hooksDir)
    const hasContext = await dirHasEntries(contextDir)

    await this.writeAuthSymlink(outputDir)
    await this.writeSettings(outputDir, options)

    const bundleManifest: PiSdkBundleManifest = {
      schemaVersion: 1,
      harnessId: 'pi-sdk',
      targetName: input.targetName,
      rootDir: outputDir,
      extensions,
      skillsDir: hasSkills ? 'skills' : undefined,
      contextFiles,
      hooks,
    }

    const manifestPath = await this.writeBundleManifest(outputDir, bundleManifest)

    const bundle: ComposedTargetBundle = {
      harnessId: 'pi-sdk',
      targetName: input.targetName,
      rootDir: outputDir,
      piSdk: {
        bundleManifestPath: manifestPath,
        extensionsDir,
        skillsDir: hasSkills ? skillsDir : undefined,
        hooksDir: hasHooks ? hooksDir : undefined,
        contextDir: hasContext ? contextDir : undefined,
      },
    }

    return { bundle, warnings }
  }

  private async mergeArtifactExtensions(
    artifact: ComposeTargetInput['artifacts'][number],
    extensionsDir: string,
    extensions: PiSdkBundleExtensionEntry[]
  ): Promise<void> {
    const srcExtDir = join(artifact.artifactPath, 'extensions')
    if (!(await isDirectory(srcExtDir))) {
      return
    }
    const entries = (await readdir(srcExtDir)).sort()
    for (const file of entries) {
      const srcPath = join(srcExtDir, file)
      const destPath = join(extensionsDir, file)
      await linkOrCopy(srcPath, destPath)
      extensions.push({
        spaceId: artifact.spaceId,
        path: normalizeBundlePath(join('extensions', file)),
      })
    }
  }

  private async mergeArtifactSkills(
    artifact: ComposeTargetInput['artifacts'][number],
    skillsDir: string
  ): Promise<void> {
    const srcSkillsDir = join(artifact.artifactPath, 'skills')
    if (!(await isDirectory(srcSkillsDir))) {
      return
    }
    const skillEntries = await readdir(srcSkillsDir, { withFileTypes: true })
    for (const entry of skillEntries) {
      if (entry.isDirectory()) {
        const srcPath = join(srcSkillsDir, entry.name)
        const destPath = join(skillsDir, entry.name)
        await copyDir(srcPath, destPath)
      }
    }
  }

  private async mergeArtifactHooks(
    artifact: ComposeTargetInput['artifacts'][number],
    hooksDir: string,
    hooks: PiSdkBundleHookEntry[]
  ): Promise<void> {
    const srcHooksDir = join(artifact.artifactPath, 'hooks')
    if (!(await isDirectory(srcHooksDir))) {
      return
    }
    const destHooksDir = join(hooksDir, artifact.spaceId)
    await copyDir(srcHooksDir, destHooksDir)

    const hooksResult = await readHooksWithPrecedence(srcHooksDir)
    const filteredHooks = hooksResult.hooks.filter(
      (hook) => !hook.harness || hook.harness === 'pi-sdk'
    )

    for (const hook of filteredHooks) {
      const resolvedScript = await resolveHookScriptRelative(hook.script, srcHooksDir)
      let scriptPath = resolvedScript

      if (!/\s/.test(resolvedScript) && !isAbsolute(resolvedScript)) {
        scriptPath = normalizeBundlePath(join('hooks', artifact.spaceId, resolvedScript))
      }

      hooks.push({
        event: hook.event,
        script: scriptPath,
        tools: hook.tools,
        blocking: hook.blocking,
      })
    }
  }

  private async mergeArtifactContext(
    artifact: ComposeTargetInput['artifacts'][number],
    contextDir: string,
    contextFiles: PiSdkBundleContextEntry[]
  ): Promise<void> {
    const srcContextDir = join(artifact.artifactPath, 'context')
    if (!(await isDirectory(srcContextDir))) {
      return
    }
    const contextEntries = await readdir(srcContextDir, { withFileTypes: true })
    for (const entry of contextEntries) {
      if (entry.isFile()) {
        const srcPath = join(srcContextDir, entry.name)
        const destPath = join(contextDir, entry.name)
        await linkOrCopy(srcPath, destPath)
        contextFiles.push({
          spaceId: artifact.spaceId,
          path: normalizeBundlePath(join('context', entry.name)),
          label: `space:${artifact.spaceId} instructions`,
        })
      }
    }
  }

  /** Symlink ~/.pi/agent/auth.json into the bundle for Pi authentication. */
  private async writeAuthSymlink(outputDir: string): Promise<void> {
    const piAuthSource = join(homedir(), '.pi', 'agent', 'auth.json')
    const piAuthDest = join(outputDir, 'auth.json')
    if (await isFile(piAuthSource)) {
      // Remove existing symlink/file if present
      await rm(piAuthDest, { force: true })
      await symlink(piAuthSource, piAuthDest)
    }
    // Otherwise ~/.pi/agent/auth.json doesn't exist - Pi will prompt for auth.
  }

  /**
   * Generate settings.json to control skill discovery. By default, disable
   * .claude/.codex directories but allow Pi directories; the --inherit-project
   * and --inherit-user flags can enable Pi directories.
   */
  private async writeSettings(outputDir: string, options: ComposeTargetOptions): Promise<void> {
    const piSettings = {
      skills: {
        enableCodexUser: false,
        enableClaudeUser: false,
        enableClaudeProject: false,
        enablePiUser: options.inheritUser ?? false,
        enablePiProject: options.inheritProject ?? false,
      },
    }
    const settingsPath = join(outputDir, 'settings.json')
    await writeFile(settingsPath, JSON.stringify(piSettings, null, 2))
  }

  /** Write bundle.json and return its path. */
  private async writeBundleManifest(
    outputDir: string,
    manifest: PiSdkBundleManifest
  ): Promise<string> {
    const manifestPath = join(outputDir, 'bundle.json')
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2))
    return manifestPath
  }

  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    if (!bundle.piSdk) {
      throw new AspError(
        'Pi SDK bundle is missing - cannot build run args',
        'PI_SDK_BUNDLE_MISSING'
      )
    }

    const args: string[] = [RUNNER_PATH]
    const bundleRoot = bundle.rootDir
    const projectPath = options.projectPath ?? bundle.rootDir
    const cwd = options.cwd ?? projectPath

    args.push('--bundle', bundleRoot, '--project', projectPath, '--cwd', cwd)

    const mode = options.interactive === false ? 'print' : 'interactive'
    args.push('--mode', mode)

    if (options.prompt) {
      args.push('--prompt', options.prompt)
    }

    // Default model for pi-sdk harness
    const model = options.model ?? DEFAULT_PI_SDK_MODEL
    args.push('--model', model)

    if (options.yolo) {
      args.push('--yolo')
    }

    // Handle continuation key: the runner threads --resume into a resumed
    // SessionManager. A string continuationKey is a session-file path
    // (SessionManager.open); a bare boolean means "continue most recent"
    // (SessionManager.continueRecent), wired as a value-less --resume flag.
    if (typeof options.continuationKey === 'string' && options.continuationKey) {
      args.push('--resume', options.continuationKey)
    } else if (options.continuationKey === true) {
      args.push('--resume')
    }

    const sdkRoot = process.env['ASP_PI_SDK_ROOT']
    if (sdkRoot) {
      args.push('--sdk-root', sdkRoot)
    }

    let hasExtensions = false
    try {
      const entries = readdirSync(bundle.piSdk.extensionsDir, { withFileTypes: true })
      hasExtensions = entries.some((entry) => entry.isFile() && entry.name.endsWith('.js'))
    } catch {
      // No extensions directory
    }

    if (!hasExtensions) {
      args.push('--no-extensions')
    }

    args.push('--no-skills')

    if (options.extraArgs) {
      args.push(...options.extraArgs)
    }

    return args
  }

  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'pi-sdk')
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const manifestPath = join(outputDir, 'bundle.json')
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

    const extensionsDir = join(outputDir, 'extensions')
    const skillsDir = join(outputDir, 'skills')
    const hooksDir = join(outputDir, 'hooks')
    const contextDir = join(outputDir, 'context')

    const skillsDirPath: string | undefined = (await dirHasEntries(skillsDir))
      ? skillsDir
      : undefined
    const hooksDirPath: string | undefined = (await dirHasEntries(hooksDir)) ? hooksDir : undefined
    const contextDirPath: string | undefined = (await dirHasEntries(contextDir))
      ? contextDir
      : undefined

    return {
      harnessId: 'pi-sdk',
      targetName,
      rootDir: outputDir,
      piSdk: {
        bundleManifestPath: manifestPath,
        extensionsDir,
        skillsDir: skillsDirPath,
        hooksDir: hooksDirPath,
        contextDir: contextDirPath,
      },
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    return { PI_CODING_AGENT_DIR: bundle.rootDir }
  }

  getDefaultRunOptions(
    _manifest: ProjectManifest,
    _targetName: string
  ): Partial<HarnessRunOptions> {
    return {}
  }
}

export const piSdkAdapter = new PiSdkAdapter()
