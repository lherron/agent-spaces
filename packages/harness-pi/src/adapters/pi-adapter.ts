/**
 * PiAdapter - Harness adapter for Pi Coding Agent
 *
 * Implements the HarnessAdapter interface for Pi, supporting:
 * - Extension bundling with Bun
 * - Skills directory handling (Agent Skills standard)
 * - Hook bridge generation for shell scripts
 * - Tool namespacing
 *
 * Cohesive concerns live in sibling modules and are re-exported here to keep
 * the public surface (`./pi-adapter.js`) stable:
 * - `errors.ts`              — Pi-specific error classes
 * - `detect.ts`             — binary discovery / version / flag probing / cache
 * - `bundle.ts`             — extension bundling + discovery
 * - `codegen/hook-bridge.ts`— hook bridge code generation
 * - `codegen/hrc-events.ts` — HRC events bridge code generation
 */

import { readdirSync } from 'node:fs'
import { mkdir, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
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
  PI_MODEL_TRANSLATION,
  type ProjectManifest,
  type SpacePiConfig,
  copyDir,
  linkOrCopy,
} from 'spaces-config'
import { WARNING_CODES } from 'spaces-config'
import {
  PERMISSIONS_TOML_FILENAME,
  hasPermissions,
  linkInstructionsFile,
  permissionsTomlExists,
  readHooksWithPrecedence,
  readPermissionsToml,
  toPiPermissions,
} from 'spaces-config'

import { type ExtensionBuildOptions, bundleExtension, discoverExtensions } from './bundle.js'
import {
  type HookDefinition,
  generateHookBridgeCode,
  resolveHookScriptPath,
} from './codegen/hook-bridge.js'
import { generateHrcEventsBridgeCode } from './codegen/hrc-events.js'
import {
  COMPONENT_DIR_NAMES,
  DEFAULT_PI_MODEL,
  HRC_RUNTIME_SESSIONS_SUBPATH,
  PI_AUTH_RELATIVE_PATH,
  PI_BLOCKING_EVENTS,
  PRAESIDIUM_VAR_RELATIVE_DIR,
} from './constants.js'
import { detectPi } from './detect.js'
import { PiBundleError } from './errors.js'
import { copyComponentDir, dirExists, fileExists, listDirEntries } from './fs-helpers.js'

// Re-export the cohesive submodules so `./pi-adapter.js` remains the stable
// public entrypoint for consumers and tests.
export { PiBundleError, PiNotFoundError } from './errors.js'
export {
  type PiInfo,
  clearPiCache,
  detectPi,
  findPiBinary,
} from './detect.js'
export { type ExtensionBuildOptions, bundleExtension, discoverExtensions } from './bundle.js'
export { type HookDefinition, generateHookBridgeCode } from './codegen/hook-bridge.js'

/** Pi permissions shape produced by `toPiPermissions`. */
type PiPermissions = ReturnType<typeof toPiPermissions>

/** Pi sub-bundle shape, populated by this adapter. */
type PiBundle = NonNullable<ComposedTargetBundle['pi']>

/**
 * Permission facets that Pi can only lint (not enforce). Each entry names a
 * facet and reads its enforcement/value off the Pi permissions object.
 */
const LINT_ONLY_FACETS: ReadonlyArray<{
  name: string
  read: (p: PiPermissions) => { enforcement?: string; value?: unknown[] } | undefined
}> = [
  { name: 'read', read: (p) => p.read },
  { name: 'write', read: (p) => p.write },
  { name: 'network', read: (p) => p.network },
  { name: 'deny.read', read: (p) => p.deny?.read },
  { name: 'deny.write', read: (p) => p.deny?.write },
  { name: 'deny.exec', read: (p) => p.deny?.exec },
  { name: 'deny.network', read: (p) => p.deny?.network },
]

/**
 * PiAdapter implements the HarnessAdapter interface for Pi Coding Agent.
 *
 * This adapter handles:
 * - Detection: finds Pi binary at ~/tools/pi-mono or PATH
 * - Validation: checks space has valid extensions
 * - Materialization: bundles TypeScript extensions to JS
 * - Composition: merges extensions, skills, generates hook bridge
 * - Invocation: builds Pi CLI arguments
 */
export class PiAdapter implements HarnessAdapter {
  readonly id = 'pi' as const
  readonly name = 'Pi Coding Agent'

  readonly models: HarnessModelInfo[] = [
    { id: DEFAULT_PI_MODEL, name: 'GPT-5.5', default: true, description: 'openai-codex provider' },
    {
      id: 'gpt-5.3-codex',
      name: 'GPT-5.3 Codex',
      description: 'openai-codex provider',
    },
    { id: 'gpt-5.3', name: 'GPT-5.3', description: 'openai-codex provider' },
    { id: 'gpt-5.2-codex', name: 'GPT-5.2 Codex', description: 'openai-codex provider' },
    { id: 'gpt-5.2', name: 'GPT-5.2', description: 'openai-codex provider' },
    { id: 'gpt-5.1', name: 'GPT-5.1', description: 'openai-codex provider' },
    { id: 'gpt-5.1-codex-max', name: 'GPT-5.1 Codex Max', description: 'openai-codex provider' },
    { id: 'gpt-5.1-codex-mini', name: 'GPT-5.1 Codex Mini', description: 'openai-codex provider' },
  ]

  /**
   * Detect if Pi is available on the system.
   */
  async detect(): Promise<HarnessDetection> {
    try {
      const info = await detectPi()
      return {
        available: true,
        version: info.version,
        path: info.path,
        capabilities: [
          ...(info.supportsExtensions ? ['extensions'] : []),
          ...(info.supportsSkills ? ['skills'] : []),
          'toolNamespacing',
        ],
      }
    } catch (error) {
      return {
        available: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Validate that a space is compatible with Pi.
   *
   * Pi intentionally opts out of space-level validation: it imposes no naming
   * pattern on extensions, skills are optional (Agent Skills standard), and the
   * MCP-only (no extensions) case is handled at composition time. This stub
   * therefore always reports valid with no warnings.
   */
  validateSpace(_input: MaterializeSpaceInput): HarnessValidationResult {
    return {
      valid: true,
      errors: [],
      warnings: [],
    }
  }

  /**
   * Materialize a single space into a Pi artifact directory.
   *
   * This bundles TypeScript extensions and copies skills/hooks.
   */
  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []

    try {
      // Clean any partial previous attempt
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      await this.bundleSpaceExtensions(input, cacheDir, files, warnings)
      await this.copySpaceComponents(input, cacheDir, files)

      // Link instructions file (AGENT.md → AGENT.md for Pi)
      const instructionsResult = await linkInstructionsFile(input.snapshotPath, cacheDir, 'pi')
      if (instructionsResult.linked && instructionsResult.destFile) {
        files.push(instructionsResult.destFile)
      }

      // Copy permissions.toml if present (for composition to read later)
      if (await permissionsTomlExists(input.snapshotPath)) {
        const srcPerms = join(input.snapshotPath, PERMISSIONS_TOML_FILENAME)
        const destPerms = join(cacheDir, PERMISSIONS_TOML_FILENAME)
        await linkOrCopy(srcPerms, destPerms)
        files.push(PERMISSIONS_TOML_FILENAME)
      }

      return {
        artifactPath: cacheDir,
        files,
        warnings,
      }
    } catch (err) {
      // Clean up on failure
      await rm(cacheDir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
  }

  /**
   * Bundle a space's TypeScript extensions into the cache dir, namespacing each
   * output as `spaceId__name.js`.
   */
  private async bundleSpaceExtensions(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[],
    warnings: string[]
  ): Promise<void> {
    // Get build options from manifest (pi config is optional extension)
    // Cast manifest to access potential pi config from extended schema.
    const manifestWithPi = input.manifest as typeof input.manifest & {
      pi?: SpacePiConfig | undefined
    }
    const buildOpts: ExtensionBuildOptions = {
      format: manifestWithPi.pi?.build?.format,
      target: manifestWithPi.pi?.build?.target,
      external: manifestWithPi.pi?.build?.external,
    }

    const extensionsDir = join(cacheDir, COMPONENT_DIR_NAMES.EXTENSIONS)
    await mkdir(extensionsDir, { recursive: true })

    const sourceExtensions = await discoverExtensions(input.snapshotPath)
    const spaceId = input.manifest.id

    for (const srcPath of sourceExtensions) {
      const srcBasename = basename(srcPath)
      const srcName = srcBasename.replace(/\.(ts|js)$/, '')
      // Namespace extension: spaceId__name.js
      const outName = `${spaceId}__${srcName}.js`
      const outPath = join(extensionsDir, outName)

      try {
        await bundleExtension(srcPath, outPath, buildOpts)
        files.push(`${COMPONENT_DIR_NAMES.EXTENSIONS}/${outName}`)
      } catch (err) {
        if (err instanceof PiBundleError) {
          warnings.push(`Failed to bundle ${srcBasename}: ${err.stderr}`)
        } else {
          throw err
        }
      }
    }
  }

  /**
   * Copy the skills/hooks/shared/scripts component directories from a space
   * snapshot into the cache dir, recording the per-entry file list where the
   * original behavior did so.
   */
  private async copySpaceComponents(
    input: MaterializeSpaceInput,
    cacheDir: string,
    files: string[]
  ): Promise<void> {
    // Copy skills directory (Agent Skills standard - same as Claude)
    const destSkillsDir = join(cacheDir, COMPONENT_DIR_NAMES.SKILLS)
    if (
      await copyComponentDir(join(input.snapshotPath, COMPONENT_DIR_NAMES.SKILLS), destSkillsDir)
    ) {
      for (const entry of await listDirEntries(destSkillsDir)) {
        files.push(`${COMPONENT_DIR_NAMES.SKILLS}/${entry}`)
      }
    }

    // Copy hooks directory as hooks-scripts/ (Pi has incompatible hooks/ format)
    const destHooksDir = join(cacheDir, COMPONENT_DIR_NAMES.HOOKS)
    if (await copyComponentDir(join(input.snapshotPath, 'hooks'), destHooksDir)) {
      for (const entry of await listDirEntries(destHooksDir)) {
        files.push(`${COMPONENT_DIR_NAMES.HOOKS}/${entry}`)
      }
    }

    // Copy shared directory (merged into the cache dir root)
    await copyComponentDir(join(input.snapshotPath, COMPONENT_DIR_NAMES.SHARED), cacheDir)

    // Copy scripts directory
    await copyComponentDir(
      join(input.snapshotPath, COMPONENT_DIR_NAMES.SCRIPTS),
      join(cacheDir, COMPONENT_DIR_NAMES.SCRIPTS)
    )
  }

  /**
   * Compose a target bundle from ordered space artifacts.
   *
   * This assembles materialized artifacts into the final target structure:
   * - asp_modules/<target>/pi/extensions/
   * - asp_modules/<target>/pi/skills/
   * - asp_modules/<target>/pi/asp-hooks.bridge.js
   */
  async composeTarget(
    input: ComposeTargetInput,
    outputDir: string,
    options: ComposeTargetOptions
  ): Promise<ComposeTargetResult> {
    const warnings: LockWarning[] = []

    // Clean output if requested
    if (options.clean) {
      await rm(outputDir, { recursive: true, force: true })
    }
    await mkdir(outputDir, { recursive: true })

    const extensionsDir = await this.mergeExtensions(input, outputDir, warnings)
    const skillsDir = await this.mergeSkills(input, outputDir)
    const allHooks = await this.mergeHooks(input, outputDir)

    const { hookBridgePath, hrcEventsBridgePath } = await this.writeBridges(
      input,
      outputDir,
      allHooks,
      warnings
    )

    const skillsDirPath = (await listDirEntries(skillsDir)).length > 0 ? skillsDir : undefined

    await this.linkPiAuth(outputDir)
    await this.writePiSettings(outputDir, options)
    await this.lintPermissions(input, warnings)

    const bundle: ComposedTargetBundle = {
      harnessId: 'pi',
      targetName: input.targetName,
      rootDir: outputDir,
      pi: {
        extensionsDir,
        skillsDir: skillsDirPath,
        hookBridgePath,
        hrcEventsBridgePath,
      },
    }

    return { bundle, warnings }
  }

  /**
   * Merge already-namespaced extension files from every artifact into the
   * output extensions dir, warning (W303) on cross-space filename collisions.
   */
  private async mergeExtensions(
    input: ComposeTargetInput,
    outputDir: string,
    warnings: LockWarning[]
  ): Promise<string> {
    const extensionsDir = join(outputDir, COMPONENT_DIR_NAMES.EXTENSIONS)
    await mkdir(extensionsDir, { recursive: true })

    // Track extension files for W303 collision detection: filename -> spaceId
    const extensionSources = new Map<string, string>()

    for (const artifact of input.artifacts) {
      const srcExtDir = join(artifact.artifactPath, COMPONENT_DIR_NAMES.EXTENSIONS)
      // Skip when the artifact has no extensions dir (ENOENT); dirExists
      // re-throws genuine IO faults (EACCES, EMFILE, ...) instead of the old
      // bare catch{} that swallowed them as "doesn't exist".
      if (!(await dirExists(srcExtDir))) {
        continue
      }
      const entries = await readdir(srcExtDir)
      for (const file of entries) {
        // Files are already namespaced: spaceId__name.js
        const srcPath = join(srcExtDir, file)
        const destPath = join(extensionsDir, file)

        // Check for W303: tool collision after namespacing
        const existingSource = extensionSources.get(file)
        if (existingSource && existingSource !== artifact.spaceId) {
          warnings.push({
            code: WARNING_CODES.PI_TOOL_COLLISION,
            message: `Extension file collision: "${file}" from "${artifact.spaceId}" overwrites file from "${existingSource}"`,
          })
        }
        extensionSources.set(file, artifact.spaceId)

        // Clear any prior file at the dest so a colliding link succeeds
        // (linkOrCopy throws EEXIST on an existing dest). Preserves the prior
        // "overwrites file from ..." semantics the W303 message describes; the
        // old broad try/catch silently swallowed the EEXIST here.
        await rm(destPath, { force: true })
        await linkOrCopy(srcPath, destPath)
      }
    }

    return extensionsDir
  }

  /**
   * Merge each artifact's skill subdirectories into the output skills dir.
   */
  private async mergeSkills(input: ComposeTargetInput, outputDir: string): Promise<string> {
    const skillsDir = join(outputDir, COMPONENT_DIR_NAMES.SKILLS)
    await mkdir(skillsDir, { recursive: true })

    for (const artifact of input.artifacts) {
      const srcSkillsDir = join(artifact.artifactPath, COMPONENT_DIR_NAMES.SKILLS)
      // Skip artifacts without a skills directory; non-ENOENT IO errors surface.
      if (!(await dirExists(srcSkillsDir))) {
        continue
      }

      // Copy each skill subdirectory
      const skillEntries = await readdir(srcSkillsDir, { withFileTypes: true })
      for (const entry of skillEntries) {
        if (entry.isDirectory()) {
          const srcPath = join(srcSkillsDir, entry.name)
          const destPath = join(skillsDir, entry.name)
          await copyDir(srcPath, destPath)
        }
      }
    }

    return skillsDir
  }

  /**
   * Merge hook script directories from each artifact and collect the resolved
   * hook definitions.
   *
   * Priority: hooks.toml (canonical harness-agnostic) > hooks.json (legacy).
   * Uses hooks-scripts/ to avoid conflict with Pi's incompatible hooks/ format.
   */
  private async mergeHooks(
    input: ComposeTargetInput,
    outputDir: string
  ): Promise<HookDefinition[]> {
    const hooksDir = join(outputDir, COMPONENT_DIR_NAMES.HOOKS)
    await mkdir(hooksDir, { recursive: true })
    const allHooks: HookDefinition[] = []

    for (const artifact of input.artifacts) {
      const srcHooksDir = join(artifact.artifactPath, COMPONENT_DIR_NAMES.HOOKS)
      // Skip artifacts without a hooks directory; non-ENOENT IO errors surface.
      if (!(await dirExists(srcHooksDir))) {
        continue
      }

      await copyDir(srcHooksDir, hooksDir)

      // Read hooks with hooks.toml taking precedence over hooks.json
      const hooksResult = await readHooksWithPrecedence(srcHooksDir)
      if (hooksResult.hooks.length > 0) {
        // Adjust script paths to be relative to composed hooks dir.
        // resolveHookScriptPath strips the ${CLAUDE_PLUGIN_ROOT}/ and hooks/
        // prefixes (hooks/ was renamed to hooks-scripts/). Only the fields
        // declared on HookDefinition are projected (the source's `matcher`
        // is intentionally not forwarded to the Pi hook bridge).
        for (const hook of hooksResult.hooks) {
          const { event, tools, blocking, harness } = hook
          const script = await resolveHookScriptPath(hook.script, hooksDir)
          allHooks.push({ event, script, tools, blocking, harness })
        }
      }
    }

    return allHooks
  }

  /**
   * Generate the hook-bridge (if any hooks) and the always-present HRC events
   * bridge extension, warning (W301) on blocking hooks Pi cannot enforce.
   */
  private async writeBridges(
    input: ComposeTargetInput,
    outputDir: string,
    allHooks: HookDefinition[],
    warnings: LockWarning[]
  ): Promise<{ hookBridgePath: string | undefined; hrcEventsBridgePath: string }> {
    let hookBridgePath: string | undefined
    const spaceIds = input.artifacts.map((a) => a.spaceId)

    if (allHooks.length > 0) {
      hookBridgePath = join(outputDir, 'asp-hooks.bridge.js')
      const hookBridgeCode = generateHookBridgeCode(allHooks, spaceIds)
      await writeFile(hookBridgePath, hookBridgeCode)

      // Check for W301: blocking hooks that Pi can't enforce
      for (const hook of allHooks) {
        if (hook.blocking && !PI_BLOCKING_EVENTS.includes(hook.event)) {
          warnings.push({
            code: WARNING_CODES.PI_HOOK_CANNOT_BLOCK,
            message: `Hook '${hook.event}' marked blocking=true but Pi cannot block this event`,
          })
        }
      }
    }

    const hrcEventsBridgePath = join(outputDir, 'asp-hrc-events.bridge.js')
    await writeFile(hrcEventsBridgePath, generateHrcEventsBridgeCode())

    return { hookBridgePath, hrcEventsBridgePath }
  }

  /**
   * Create a symlink to ~/.pi/agent/auth.json for Pi authentication, when the
   * source auth file exists.
   */
  private async linkPiAuth(outputDir: string): Promise<void> {
    const piAuthSource = join(homedir(), ...PI_AUTH_RELATIVE_PATH)
    const piAuthDest = join(outputDir, 'auth.json')
    try {
      const authStats = await stat(piAuthSource)
      if (authStats.isFile()) {
        // Remove existing symlink/file if present
        await rm(piAuthDest, { force: true })
        await symlink(piAuthSource, piAuthDest)
      }
    } catch {
      // ~/.pi/auth.json doesn't exist - Pi will prompt for auth
    }
  }

  /**
   * Generate settings.json to control skill discovery.
   *
   * By default, disable .claude/.codex directories but allow Pi directories.
   * The --inherit-project and --inherit-user flags enable Pi directories.
   */
  private async writePiSettings(outputDir: string, options: ComposeTargetOptions): Promise<void> {
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

  /**
   * Read permissions.toml from each artifact and emit a W304 warning for any
   * facets Pi can only lint (not enforce).
   */
  private async lintPermissions(input: ComposeTargetInput, warnings: LockWarning[]): Promise<void> {
    for (const artifact of input.artifacts) {
      const permissions = await readPermissionsToml(artifact.artifactPath)
      if (permissions && hasPermissions(permissions)) {
        const piPerms = toPiPermissions(permissions)

        // Generate W304 warning for each lint_only permission facet
        const lintOnlyFacets = this.collectLintOnlyFacets(piPerms)

        if (lintOnlyFacets.length > 0) {
          warnings.push({
            code: WARNING_CODES.PI_PERMISSION_LINT_ONLY,
            message: `Space "${artifact.spaceId}" has permissions.toml with facets that Pi cannot enforce (lint-only): ${lintOnlyFacets.join(', ')}`,
          })
        }
      }
    }
  }

  private collectLintOnlyFacets(piPerms: PiPermissions): string[] {
    const lintOnlyFacets: string[] = []

    for (const { name, read } of LINT_ONLY_FACETS) {
      const facet = read(piPerms)
      if (facet?.enforcement === 'lint_only' && facet.value?.length) {
        lintOnlyFacets.push(name)
      }
    }

    return lintOnlyFacets
  }

  /**
   * Build CLI arguments for running Pi with a composed target bundle.
   *
   * This is a synchronous method (required by interface), so we use sync fs operations.
   */
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    const args: string[] = []

    if (!bundle.pi) {
      throw new AspError('Pi bundle is missing - cannot build run args', 'PI_BUNDLE_MISSING')
    }

    const piBundle = bundle.pi

    // Add replacement system prompt and reminder paths before other runtime flags.
    if (options.systemPrompt) {
      args.push('--system-prompt', options.systemPrompt)
    }
    if (options.reminderContent) {
      args.push('--append-system-prompt', options.reminderContent)
    }

    // Keep Pi from loading native context files; Agent Spaces owns prompt context.
    args.push('--no-context-files')

    this.pushExtensionArgs(args, piBundle)
    this.pushSkillArgs(args, piBundle)
    this.pushModelArgs(args, options)
    this.pushContinuationArgs(args, bundle, options)

    // Add extra args
    if (options.extraArgs) {
      args.push(...options.extraArgs)
    }

    // Add prompt as positional argument (Pi takes prompt after flags)
    if (options.prompt) {
      args.push(options.prompt)
    }

    // Note: Pi uses cwd for project path, not a positional argument

    return args
  }

  /**
   * Push extension flags (discovered `.js` extensions + hook/HRC bridges), or
   * `--no-extensions` when none are present.
   */
  private pushExtensionArgs(args: string[], piBundle: PiBundle): void {
    const extensionsDir = piBundle.extensionsDir
    let hasExtensions = false

    // Use readdirSync to list extension files (sync required by interface)
    const entries = readdirSync(extensionsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.js')) {
        args.push('--extension', join(extensionsDir, entry.name))
        hasExtensions = true
      }
    }

    // Add hook bridge extension
    if (piBundle.hookBridgePath) {
      args.push('--extension', piBundle.hookBridgePath)
      hasExtensions = true
    }

    if (piBundle.hrcEventsBridgePath) {
      args.push('--extension', piBundle.hrcEventsBridgePath)
      hasExtensions = true
    }

    // If no extensions found, add --no-extensions flag
    if (!hasExtensions) {
      args.push('--no-extensions')
    }
  }

  /**
   * Disable default skill loading and add the bundle's skills directory when present.
   */
  private pushSkillArgs(args: string[], piBundle: PiBundle): void {
    // Disable default skill loading from local/user directories.
    args.push('--no-skills')
    if (piBundle.skillsDir) {
      args.push('--skill', piBundle.skillsDir)
    }
  }

  /**
   * Push model/provider flags plus `--print` for non-interactive runs.
   */
  private pushModelArgs(args: string[], options: HarnessRunOptions): void {
    // Model translation (sonnet -> claude-sonnet, etc.)
    // Default to gpt-5.5 with openai-codex provider if no model specified
    const model = options.model || DEFAULT_PI_MODEL
    const translatedModel = PI_MODEL_TRANSLATION[model] || model
    args.push('--model', translatedModel)

    // Default provider for Pi
    args.push('--provider', 'openai-codex')

    // Add --print for non-interactive mode
    if (options.interactive === false) {
      args.push('--print')
    }
  }

  /**
   * Push continuation flags: `--resume` opens Pi's picker; a string key uses a
   * named session under the resolved session dir.
   */
  private pushContinuationArgs(
    args: string[],
    bundle: ComposedTargetBundle,
    options: HarnessRunOptions
  ): void {
    // Handle continuation: true opens Pi's picker; string uses a named session.
    if (options.continuationKey === true) {
      args.push('--resume')
    } else if (typeof options.continuationKey === 'string' && options.continuationKey) {
      const sessionDir = this.resolveSessionDir(bundle, options)
      args.push('--session', options.continuationKey, '--session-dir', sessionDir)
    }
  }

  /**
   * Resolve the `--session-dir` for a named-session continuation.
   *
   * When the run is attached to an HRC runtime, sessions live under that
   * runtime's state dir (`<aspHome>/<sessions-subpath>/<runtimeId>/pi-sessions`,
   * falling back to the praesidium var dir under the home directory). Otherwise
   * they live alongside the composed bundle.
   */
  private resolveSessionDir(bundle: ComposedTargetBundle, options: HarnessRunOptions): string {
    const runtimeId = (options as HarnessRunOptions & { runtimeId?: string | undefined }).runtimeId
    if (!runtimeId) {
      return join(bundle.rootDir, COMPONENT_DIR_NAMES.SESSIONS)
    }

    const aspHome = options.aspHome ?? join(homedir(), ...PRAESIDIUM_VAR_RELATIVE_DIR)
    return join(aspHome, HRC_RUNTIME_SESSIONS_SUBPATH, runtimeId, 'pi-sessions')
  }

  /**
   * Get the output directory path for a Pi target bundle.
   *
   * Returns: asp_modules/<targetName>/pi
   */
  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'pi')
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const extensionsDir = join(outputDir, COMPONENT_DIR_NAMES.EXTENSIONS)
    const skillsDir = join(outputDir, COMPONENT_DIR_NAMES.SKILLS)
    const hookBridgePath = join(outputDir, 'asp-hooks.bridge.js')
    const hrcEventsBridgePath = join(outputDir, 'asp-hrc-events.bridge.js')

    const skillsDirPath = (await listDirEntries(skillsDir)).length > 0 ? skillsDir : undefined
    const hookBridge = (await fileExists(hookBridgePath)) ? hookBridgePath : undefined
    const hrcEventsBridge = (await fileExists(hrcEventsBridgePath))
      ? hrcEventsBridgePath
      : undefined

    return {
      harnessId: 'pi',
      targetName,
      rootDir: outputDir,
      pi: {
        extensionsDir,
        skillsDir: skillsDirPath,
        hookBridgePath: hookBridge,
        hrcEventsBridgePath: hrcEventsBridge,
      },
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, options: HarnessRunOptions): Record<string, string> {
    return {
      PI_CODING_AGENT_DIR: bundle.rootDir,
      ...(options.prompt ? { ASP_PRIMING_PROMPT: options.prompt } : {}),
    }
  }

  /**
   * Pi intentionally provides no default run options; the runtime supplies all
   * invocation options explicitly.
   */
  getDefaultRunOptions(
    _manifest: ProjectManifest,
    _targetName: string
  ): Partial<HarnessRunOptions> {
    return {}
  }
}

/**
 * Singleton instance of PiAdapter
 */
export const piAdapter = new PiAdapter()
