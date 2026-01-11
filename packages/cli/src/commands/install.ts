/**
 * Install command - Generate/update lock file and materialize to asp_modules.
 */

import type { Command } from 'commander'

import { getClaudeCommand } from '@agent-spaces/claude'
import { getEffectiveClaudeOptions, readTargetsToml } from '@agent-spaces/core'
import { type HarnessId, harnessRegistry, install, isHarnessId } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'
import {
  blank,
  colors,
  commandBlock,
  createSpinner,
  error,
  formatDuration,
  formatPath,
  header,
  info,
  success,
  symbols,
} from '../ui.js'

/**
 * Validate harness option and return the harness ID.
 * In Phase 1, only 'claude' is supported.
 */
function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    blank()
    error(`Unknown harness "${harnessId}"`)
    console.log(colors.muted('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.log(colors.muted(`  - ${adapter.id}`))
    }
    blank()
    process.exit(1)
  }

  // Phase 1: Only claude is supported
  if (harnessId !== 'claude') {
    blank()
    error(`Harness "${harnessId}" is not yet supported`)
    console.log(colors.muted('Currently only "claude" is available.'))
    console.log(colors.muted('Run "asp harnesses" to see available harnesses.'))
    blank()
    process.exit(1)
  }

  return harnessId
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Resolve targets and materialize to asp_modules/')
    .option('--targets <names...>', 'Specific targets to install')
    .option('--harness <id>', 'Coding agent harness to use (default: claude)')
    .option('--update', 'Update existing lock (re-resolve selectors)')
    .option('--no-fetch', 'Skip fetching registry updates')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI orchestration with multiple paths
    .action(async (options) => {
      // Validate harness option (Phase 1: only claude supported)
      const _harness = validateHarness(options.harness)
      const startTime = Date.now()

      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        blank()
        error('No asp-targets.toml found')
        console.log(colors.muted('  Run from a project directory or use --project'))
        blank()
        process.exit(1)
      }

      // Start spinner
      const spinner = createSpinner('Resolving dependencies...')
      spinner.start()

      try {
        const result = await install({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: options.targets,
          update: options.update,
          fetchRegistry: options.fetch !== false,
        })

        spinner.stop()
        const duration = Date.now() - startTime

        // Success header
        blank()
        success(
          `Installed ${result.resolvedTargets.length} target${result.resolvedTargets.length !== 1 ? 's' : ''} in ${formatDuration(duration)}`
        )

        // Lock file info
        info('lock', formatPath(result.lockPath))

        // Load manifest for claude options
        const manifestPath = `${projectPath}/asp-targets.toml`
        const manifest = await readTargetsToml(manifestPath)

        // Each target
        header('Targets')

        for (const mat of result.materializations) {
          const claudeOptions = getEffectiveClaudeOptions(manifest, mat.target)

          // Generate command
          let command: string
          try {
            command = await getClaudeCommand({
              pluginDirs: mat.pluginDirs,
              mcpConfig: mat.mcpConfigPath,
              settings: mat.settingsPath,
              settingSources: '',
              model: claudeOptions.model,
              permissionMode: claudeOptions.permission_mode,
              args: claudeOptions.args,
            })
          } catch {
            // Claude not installed - build a generic command
            const pluginArgs = mat.pluginDirs.map((d) => `--plugin-dir ${d}`).join(' ')
            command = `claude ${pluginArgs} --settings ${mat.settingsPath}`
          }

          // Target display
          blank()
          console.log(`  ${symbols.pointer} ${colors.emphasis(mat.target)}`)
          console.log(
            `    ${colors.muted(`${mat.pluginDirs.length} plugin${mat.pluginDirs.length !== 1 ? 's' : ''}${mat.mcpConfigPath ? ' · mcp' : ''}`)}`
          )

          commandBlock('run', command)
        }

        blank()
      } catch (err) {
        spinner.stop()
        blank()
        error(err instanceof Error ? err.message : String(err))
        blank()
        process.exit(1)
      }
    })
}
