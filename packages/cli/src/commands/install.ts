/**
 * Install command - Generate/update lock file and materialize to asp_modules.
 */

import type { Command } from 'commander'

import { isConfigError, readTargetsToml } from 'spaces-config'
import { type HarnessId, harnessRegistry, install, isHarnessId } from 'spaces-execution'

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

  return harnessId
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function formatCommand(commandPath: string, args: string[]): string {
  return [shellQuote(commandPath), ...args.map(shellQuote)].join(' ')
}

function formatEnvPrefix(env: Record<string, string>): string {
  const entries = Object.entries(env)
  if (entries.length === 0) return ''
  return `${entries.map(([key, value]) => `${key}=${shellQuote(value)}`).join(' ')} `
}

export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Resolve targets and materialize to asp_modules/')
    .option('--targets <names...>', 'Specific targets to install')
    .option(
      '--harness <id>',
      'Coding agent harness to use (default: claude, e.g., claude-agent-sdk, codex, pi, pi-sdk)'
    )
    .option('--update', 'Update existing lock (re-resolve selectors)')
    .option('--refresh', 'Force re-copy from source (clear cache)')
    .option('--no-fetch', 'Skip fetching registry updates')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      // Validate harness option
      const _harness = validateHarness(options.harness)
      const harnessId = _harness
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
          refresh: options.refresh,
          fetchRegistry: options.fetch !== false,
          harness: harnessId,
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

        const adapter = harnessRegistry.getOrThrow(harnessId)
        let harnessPath: string = harnessId
        try {
          const detection = await adapter.detect()
          harnessPath = detection.path ?? harnessId
        } catch {
          // Harness may not be installed; fall back to id
        }

        // Each target
        header('Targets')

        for (const mat of result.materializations) {
          const bundle = await adapter.loadTargetBundle(mat.outputPath, mat.target)
          const defaults = adapter.getDefaultRunOptions(manifest, mat.target)
          const args = adapter.buildRunArgs(bundle, defaults)
          const envPrefix = formatEnvPrefix(adapter.getRunEnv(bundle, defaults))
          const command = envPrefix + formatCommand(harnessPath, args)

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
        if (isConfigError(err)) {
          error(err.message)
          console.log(colors.muted(`  at ${formatPath(err.source)}`))
        } else {
          error(err instanceof Error ? err.message : String(err))
        }
        blank()
        process.exit(1)
      }
    })
}
