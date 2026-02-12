/**
 * ClaudeAdapter - Harness adapter for Claude Code
 *
 * Implements the HarnessAdapter interface for Claude Code, wrapping
 * existing functionality from spaces-claude and spaces-materializer.
 */

import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type {
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessModelInfo,
  HarnessRunOptions,
  HarnessValidationResult,
  LockWarning,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
  ProjectManifest,
} from 'spaces-config'
import { copyDir, getEffectiveClaudeOptions, linkOrCopy } from 'spaces-config'
import {
  PERMISSIONS_TOML_FILENAME,
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  ensureHooksExecutable,
  hooksTomlExists,
  linkComponents,
  linkInstructionsFile,
  permissionsTomlExists,
  readHooksToml,
  readPermissionsToml,
  toClaudePermissions,
  toClaudeSettingsPermissions,
  validateHooks,
  writeClaudeHooksJson,
  writePluginJson,
} from 'spaces-config'
import { buildClaudeArgs, detectClaude } from '../claude/index.js'

/**
 * ClaudeAdapter implements the HarnessAdapter interface for Claude Code.
 *
 * This adapter wraps existing Claude-specific functionality:
 * - Detection: uses spaces-claude/detect
 * - Materialization: uses spaces-materializer
 * - Invocation: uses spaces-claude/invoke
 */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const
  readonly name = 'Claude Code'

  readonly models: HarnessModelInfo[] = [
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', default: true },
    { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5' },
    { id: 'opus', name: 'Opus (alias)' },
    { id: 'sonnet', name: 'Sonnet (alias)' },
    { id: 'haiku', name: 'Haiku (alias)' },
  ]

  /**
   * Detect if Claude is available on the system.
   */
  async detect(): Promise<HarnessDetection> {
    try {
      const info = await detectClaude()
      return {
        available: true,
        version: info.version,
        path: info.path,
        capabilities: [
          'multiPlugin',
          'settingsFlag',
          ...(info.supportsMcpConfig ? ['mcpConfig'] : []),
          ...(info.supportsPluginDir ? ['pluginDir'] : []),
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
   * Validate that a space is compatible with Claude.
   *
   * Claude spaces must have valid plugin metadata and can optionally have:
   * - commands/ directory
   * - agents/ directory
   * - skills/ directory
   * - hooks/ directory with hooks.json
   * - mcp/ directory with MCP server configs
   */
  validateSpace(input: MaterializeSpaceInput): HarnessValidationResult {
    const errors: string[] = []
    const warnings: string[] = []

    // Validate plugin name
    const pluginName = input.manifest.plugin?.name ?? input.manifest.id
    if (!pluginName) {
      errors.push('Space must have an id or plugin.name')
    } else if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(pluginName)) {
      warnings.push(`Plugin name '${pluginName}' should be kebab-case`)
    }

    // Claude-specific validations could be added here
    // For now, most validation happens during materialization

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    }
  }

  /**
   * Materialize a single space into a Claude plugin directory.
   *
   * This wraps the existing materialization logic from spaces-materializer.
   */
  async materializeSpace(
    input: MaterializeSpaceInput,
    cacheDir: string,
    options: MaterializeSpaceOptions
  ): Promise<MaterializeSpaceResult> {
    const warnings: string[] = []
    const files: string[] = []
    // Use copy instead of hardlinks when useHardlinks=false (dev mode)
    // This protects source files from being modified by generated artifacts
    const linkOptions = { forceCopy: options.useHardlinks === false }

    try {
      // Clean any partial previous attempt
      if (options.force) {
        await rm(cacheDir, { recursive: true, force: true })
      }
      await mkdir(cacheDir, { recursive: true })

      // Write plugin.json
      await writePluginJson(input.manifest, cacheDir)
      files.push('.claude-plugin/plugin.json')

      // Link components from snapshot
      const linked = await linkComponents(input.snapshotPath, cacheDir, linkOptions)
      files.push(...linked)

      // Link instructions file (AGENT.md → CLAUDE.md or CLAUDE.md → CLAUDE.md)
      const instructionsResult = await linkInstructionsFile(
        input.snapshotPath,
        cacheDir,
        'claude',
        linkOptions
      )
      if (instructionsResult.linked && instructionsResult.destFile) {
        files.push(instructionsResult.destFile)
      }

      // Copy permissions.toml if present (for composition to read later)
      if (await permissionsTomlExists(input.snapshotPath)) {
        const srcPerms = join(input.snapshotPath, PERMISSIONS_TOML_FILENAME)
        const destPerms = join(cacheDir, PERMISSIONS_TOML_FILENAME)
        if (linkOptions.forceCopy) {
          await copyFile(srcPerms, destPerms)
        } else {
          await linkOrCopy(srcPerms, destPerms)
        }
        files.push(PERMISSIONS_TOML_FILENAME)
      }

      // Generate hooks.json from hooks.toml if present
      // hooks.toml is the canonical harness-agnostic format
      const hooksDir = join(cacheDir, 'hooks')
      if (await hooksTomlExists(hooksDir)) {
        const hooksToml = await readHooksToml(hooksDir)
        if (hooksToml && hooksToml.hook.length > 0) {
          await writeClaudeHooksJson(hooksToml.hook, hooksDir)
          // Note: hooks.json may already be in files from linkComponents
          // but writing it again is fine - it will be the generated version
        }
      }

      // Validate and fix hooks
      const hookResult = await validateHooks(cacheDir)
      warnings.push(...hookResult.warnings)
      if (!hookResult.valid) {
        warnings.push(...hookResult.errors)
      }
      await ensureHooksExecutable(cacheDir)

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
   * Compose a target bundle from ordered space artifacts.
   *
   * This assembles materialized plugins into the final target structure:
   * - asp_modules/<target>/plugins/<NNN-spaceId>/
   * - asp_modules/<target>/mcp.json
   * - asp_modules/<target>/settings.json
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

    // Create plugins directory
    const pluginsDir = join(outputDir, 'plugins')
    await mkdir(pluginsDir, { recursive: true })

    // Copy ordered space artifacts with numeric prefixes
    const pluginDirs: string[] = []
    for (let i = 0; i < input.artifacts.length; i++) {
      const artifact = input.artifacts[i]
      if (!artifact) continue

      const prefixed = `${String(i).padStart(3, '0')}-${artifact.spaceId}`
      const destPath = join(pluginsDir, prefixed)

      // Copy the artifact directory to the target (use hardlinks where possible)
      await copyDir(artifact.artifactPath, destPath, { useHardlinks: true })
      pluginDirs.push(destPath)
    }

    // Compose MCP config from all plugins
    let mcpConfigPath: string | undefined
    const mcpOutputPath = join(outputDir, 'mcp.json')
    const spacesForMcp = pluginDirs.map((dir, i) => ({
      spaceId: input.artifacts[i]?.spaceId ?? 'unknown',
      dir,
    }))

    const { config: mcpConfig, warnings: mcpWarnings } = await composeMcpFromSpaces(
      spacesForMcp,
      mcpOutputPath
    )

    for (const w of mcpWarnings) {
      warnings.push({ code: 'W_MCP', message: w })
    }

    if (Object.keys(mcpConfig.mcpServers).length > 0) {
      mcpConfigPath = mcpOutputPath
    }

    // Compose settings from all spaces (including permissions.toml)
    const settingsOutputPath = join(outputDir, 'settings.json')

    // Read permissions.toml from each artifact and merge with space settings
    const settingsInputs: SettingsInput[] = []
    for (let i = 0; i < input.artifacts.length; i++) {
      const artifact = input.artifacts[i]
      if (!artifact) continue

      // Start with space settings from manifest
      const spaceSettings = input.settingsInputs[i] ?? {}
      const mergedSettings = { ...spaceSettings }

      // Read permissions.toml from artifact if it exists
      const permissions = await readPermissionsToml(artifact.artifactPath)

      if (permissions) {
        // Translate permissions to Claude format
        const claudePerms = toClaudePermissions(permissions)
        const settingsPerms = toClaudeSettingsPermissions(claudePerms)

        // Merge with existing permissions
        if (settingsPerms.allow?.length || settingsPerms.deny?.length) {
          if (!mergedSettings.permissions) {
            mergedSettings.permissions = {}
          }

          if (settingsPerms.allow?.length) {
            mergedSettings.permissions.allow = [
              ...(mergedSettings.permissions.allow ?? []),
              ...settingsPerms.allow,
            ]
          }

          if (settingsPerms.deny?.length) {
            mergedSettings.permissions.deny = [
              ...(mergedSettings.permissions.deny ?? []),
              ...settingsPerms.deny,
            ]
          }
        }
      }

      // Only include if there are actual settings
      if (Object.keys(mergedSettings).length > 0) {
        settingsInputs.push({
          spaceId: artifact.spaceId,
          settings: mergedSettings,
        })
      }
    }

    await composeSettingsFromSpaces(settingsInputs, settingsOutputPath)

    const bundle: ComposedTargetBundle = {
      harnessId: 'claude',
      targetName: input.targetName,
      rootDir: outputDir,
      pluginDirs,
      mcpConfigPath,
      settingsPath: settingsOutputPath,
    }

    return { bundle, warnings }
  }

  /**
   * Build CLI arguments for running Claude with a composed target bundle.
   */
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    const settingSources =
      options.settingSources === null
        ? undefined
        : options.settingSources === undefined
          ? ''
          : options.settingSources

    const promptArgs: string[] = []
    if (options.interactive === false) {
      promptArgs.push('-p')
      if (options.prompt) {
        promptArgs.push(options.prompt)
      }
    }

    // Handle resume option: --resume [session-id] or -r [session-id]
    const resumeArgs: string[] = []
    if (options.resume) {
      if (typeof options.resume === 'string') {
        resumeArgs.push('--resume', options.resume)
      } else {
        // true means open picker
        resumeArgs.push('--resume')
      }
    }

    const extraArgs = [
      ...(options.yolo ? ['--dangerously-skip-permissions'] : []),
      ...(options.extraArgs ?? []),
      ...resumeArgs,
      ...promptArgs,
    ]

    // Delegate to the existing buildClaudeArgs function
    return buildClaudeArgs({
      pluginDirs: bundle.pluginDirs,
      mcpConfig: bundle.mcpConfigPath,
      settings: options.settings ?? bundle.settingsPath,
      permissionMode: options.permissionMode,
      settingSources,
      debug: options.debug,
      model: options.model,
      args: extraArgs,
    })
  }

  /**
   * Get the output directory path for a Claude target bundle.
   *
   * Returns: asp_modules/<targetName>/claude
   */
  getTargetOutputPath(aspModulesDir: string, targetName: string): string {
    return join(aspModulesDir, targetName, 'claude')
  }

  async loadTargetBundle(outputDir: string, targetName: string): Promise<ComposedTargetBundle> {
    const pluginsPath = join(outputDir, 'plugins')
    const entries = await readdir(pluginsPath, { withFileTypes: true })

    const pluginDirs: string[] = []
    for (const entry of entries) {
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        pluginDirs.push(join(pluginsPath, entry.name))
      }
    }
    pluginDirs.sort()

    const mcpPath = join(outputDir, 'mcp.json')
    let mcpConfigPath: string | undefined
    try {
      const mcpStats = await stat(mcpPath)
      if (mcpStats.size > 2) {
        mcpConfigPath = mcpPath
      }
    } catch {
      // MCP config is optional
    }

    const settingsPath = join(outputDir, 'settings.json')

    return {
      harnessId: 'claude',
      targetName,
      rootDir: outputDir,
      pluginDirs,
      mcpConfigPath,
      settingsPath,
    }
  }

  getRunEnv(bundle: ComposedTargetBundle, _options: HarnessRunOptions): Record<string, string> {
    return { ASP_PLUGIN_ROOT: bundle.rootDir }
  }

  getDefaultRunOptions(manifest: ProjectManifest, targetName: string): Partial<HarnessRunOptions> {
    const claudeOptions = getEffectiveClaudeOptions(manifest, targetName)
    const target = manifest.targets[targetName]

    return {
      model: claudeOptions.model,
      permissionMode: claudeOptions.permission_mode,
      extraArgs: claudeOptions.args,
      yolo: target?.yolo ?? false,
    }
  }
}

/**
 * Singleton instance of ClaudeAdapter
 */
export const claudeAdapter = new ClaudeAdapter()
