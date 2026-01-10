/**
 * Build command - Materialize plugins without launching Claude.
 *
 * WHY: Allows users to pre-build plugin directories for inspection
 * or use with other tools. Also useful for CI/CD pipelines.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { build, buildAll } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the build command.
 */
export function registerBuildCommand(program: Command): void {
  program
    .command('build')
    .description('Materialize plugins without launching Claude')
    .argument('[target]', 'Target to build (default: all)')
    .requiredOption('--output <dir>', 'Output directory for materialized plugins')
    .option('--no-clean', 'Keep existing output directory contents')
    .option('--no-install', 'Do not auto-install if lock missing')
    .option('--no-lint', 'Skip lint checks')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (target: string | undefined, options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      const buildOptions = {
        projectPath,
        outputDir: options.output,
        aspHome: options.aspHome,
        registryPath: options.registry,
        clean: options.clean !== false,
        autoInstall: options.install !== false,
        runLint: options.lint !== false,
      }

      try {
        if (target) {
          // Build single target
          console.log(chalk.blue(`Building target "${target}"...`))
          const result = await build(target, buildOptions)

          console.log('')
          console.log(chalk.green('Build complete'))
          console.log(`  Plugin directories: ${result.pluginDirs.length}`)
          for (const dir of result.pluginDirs) {
            console.log(`    - ${dir}`)
          }
          if (result.mcpConfigPath) {
            console.log(`  MCP config: ${result.mcpConfigPath}`)
          }
          if (result.warnings.length > 0) {
            console.log('')
            console.log(chalk.yellow('Warnings:'))
            for (const warning of result.warnings) {
              console.log(`  [${warning.code}] ${warning.message}`)
            }
          }
        } else {
          // Build all targets
          console.log(chalk.blue('Building all targets...'))
          const results = await buildAll(buildOptions)

          console.log('')
          console.log(chalk.green('Build complete'))
          for (const [name, result] of results) {
            console.log(`  ${name}: ${result.pluginDirs.length} plugins`)
          }
        }
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`Error: ${error.message}`))
        } else {
          console.error(chalk.red(`Error: ${String(error)}`))
        }
        process.exit(1)
      }
    })
}
