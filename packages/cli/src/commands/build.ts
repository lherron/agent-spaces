/**
 * Build command - Materialize plugins without launching Claude.
 *
 * WHY: Allows users to pre-build plugin directories for inspection
 * or use with other tools. Also useful for CI/CD pipelines.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type BuildResult, build, buildAll } from 'spaces-config'
import { type HarnessId, harnessRegistry, isHarnessId } from 'spaces-execution'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

interface BuildOptions extends CommonOptions {
  output: string
  clean: boolean
  install: boolean
  lint: boolean
  harness?: string
}

/**
 * Validate harness option and return the harness ID.
 */
function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    console.error(chalk.red(`Error: Unknown harness "${harnessId}"`))
    console.error(chalk.gray(''))
    console.error(chalk.gray('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.error(chalk.gray(`  - ${adapter.id}`))
    }
    process.exit(1)
  }

  return harnessId
}

/**
 * Format single target build result for display.
 */
function formatSingleBuildResult(result: BuildResult): void {
  console.log('')
  console.log(chalk.green('Build complete'))
  console.log(`  Plugin directories: ${result.pluginDirs.length}`)
  for (const dir of result.pluginDirs) {
    console.log(`    - ${dir}`)
  }
  if (result.mcpConfigPath) {
    console.log(`  MCP config: ${result.mcpConfigPath}`)
  }
  formatBuildWarnings(result.warnings)
}

/**
 * Format build warnings for display.
 */
function formatBuildWarnings(warnings: BuildResult['warnings']): void {
  if (warnings.length === 0) return
  console.log('')
  console.log(chalk.yellow('Warnings:'))
  for (const warning of warnings) {
    console.log(`  [${warning.code}] ${warning.message}`)
  }
}

/**
 * Format all targets build results for display.
 */
function formatAllBuildResults(results: Map<string, BuildResult>): void {
  console.log('')
  console.log(chalk.green('Build complete'))
  for (const [name, result] of results) {
    console.log(`  ${name}: ${result.pluginDirs.length} plugins`)
  }
}

/**
 * Register the build command.
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('Materialize plugins without launching Claude')
    .argument('[target]', 'Target to build (default: all)')
    .requiredOption('--output <dir>', 'Output directory for materialized plugins')
    .option(
      '--harness <id>',
      'Coding agent harness to use (default: claude, e.g., claude-agent-sdk, pi, pi-sdk)'
    )
    .option('--no-clean', 'Keep existing output directory contents')
    .option('--no-install', 'Do not auto-install if lock missing')
    .option('--no-lint', 'Skip lint checks')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (target: string | undefined, options: BuildOptions) => {
      try {
        // Validate harness option
        const _harness = validateHarness(options.harness)
        const ctx = await getProjectContext(options)

        const buildOptions = {
          projectPath: ctx.projectPath,
          outputDir: options.output,
          aspHome: ctx.aspHome,
          registryPath: ctx.registryPath,
          clean: options.clean !== false,
          autoInstall: options.install !== false,
          runLint: options.lint !== false,
          harness: _harness,
        }

        if (target) {
          console.log(chalk.blue(`Building target "${target}"...`))
          const result = await build(target, buildOptions)
          formatSingleBuildResult(result)
        } else {
          console.log(chalk.blue('Building all targets...'))
          const results = await buildAll(buildOptions)
          formatAllBuildResults(results)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
