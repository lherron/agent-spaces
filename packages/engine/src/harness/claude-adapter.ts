/**
 * ClaudeAdapter - Harness adapter for Claude Code
 *
 * Implements the HarnessAdapter interface for Claude Code, wrapping
 * existing functionality from @agent-spaces/claude and @agent-spaces/materializer.
 */

import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { buildClaudeArgs, detectClaude } from '@agent-spaces/claude'
import type {
  ComposeTargetInput,
  ComposeTargetOptions,
  ComposeTargetResult,
  ComposedTargetBundle,
  HarnessAdapter,
  HarnessDetection,
  HarnessRunOptions,
  HarnessValidationResult,
  LockWarning,
  MaterializeSpaceInput,
  MaterializeSpaceOptions,
  MaterializeSpaceResult,
} from '@agent-spaces/core'
import { copyDir } from '@agent-spaces/core'
import {
  type SettingsInput,
  composeMcpFromSpaces,
  composeSettingsFromSpaces,
  ensureHooksExecutable,
  hooksTomlExists,
  linkComponents,
  linkInstructionsFile,
  readHooksToml,
  validateHooks,
  writeClaudeHooksJson,
  writePluginJson,
} from '@agent-spaces/materializer'

/**
 * ClaudeAdapter implements the HarnessAdapter interface for Claude Code.
 *
 * This adapter wraps existing Claude-specific functionality:
 * - Detection: uses @agent-spaces/claude/detect
 * - Materialization: uses @agent-spaces/materializer
 * - Invocation: uses @agent-spaces/claude/invoke
 */
export class ClaudeAdapter implements HarnessAdapter {
  readonly id = 'claude' as const
  readonly name = 'Claude Code'

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
   * This wraps the existing materialization logic from @agent-spaces/materializer.
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

      // Write plugin.json
      await writePluginJson(input.manifest, cacheDir)
      files.push('.claude-plugin/plugin.json')

      // Link components from snapshot
      const linked = await linkComponents(input.snapshotPath, cacheDir)
      files.push(...linked)

      // Link instructions file (AGENT.md → CLAUDE.md or CLAUDE.md → CLAUDE.md)
      const instructionsResult = await linkInstructionsFile(input.snapshotPath, cacheDir, 'claude')
      if (instructionsResult.linked && instructionsResult.destFile) {
        files.push(instructionsResult.destFile)
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

    // Compose settings from all spaces
    let settingsPath: string | undefined
    const settingsOutputPath = join(outputDir, 'settings.json')

    // Convert SpaceSettings[] to SettingsInput[]
    const settingsInputs: SettingsInput[] = input.artifacts
      .map((artifact, i) => ({
        spaceId: artifact.spaceId,
        settings: input.settingsInputs[i] ?? {},
      }))
      .filter((s) => s.settings && Object.keys(s.settings).length > 0)

    if (settingsInputs.length > 0) {
      const { settings: composedSettings } = await composeSettingsFromSpaces(
        settingsInputs,
        settingsOutputPath
      )
      if (composedSettings && Object.keys(composedSettings).length > 0) {
        settingsPath = settingsOutputPath
      }
    }

    const bundle: ComposedTargetBundle = {
      harnessId: 'claude',
      targetName: input.targetName,
      rootDir: outputDir,
      pluginDirs,
      mcpConfigPath,
      settingsPath,
    }

    return { bundle, warnings }
  }

  /**
   * Build CLI arguments for running Claude with a composed target bundle.
   */
  buildRunArgs(bundle: ComposedTargetBundle, options: HarnessRunOptions): string[] {
    // Delegate to the existing buildClaudeArgs function
    return buildClaudeArgs({
      pluginDirs: bundle.pluginDirs,
      mcpConfig: bundle.mcpConfigPath,
      settings: bundle.settingsPath,
      settingSources: options.settingSources ?? undefined,
      model: options.model,
      args: options.extraArgs,
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
}

/**
 * Singleton instance of ClaudeAdapter
 */
export const claudeAdapter = new ClaudeAdapter()
