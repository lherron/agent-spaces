/**
 * Install command - Generate/update lock file and populate store.
 *
 * WHY: This command resolves all targets in the project manifest,
 * creates a lock file for reproducibility, and extracts space
 * snapshots to the content-addressed store.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { install } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the install command.
 */
export function registerInstallCommand(program: Command): void {
  program
    .command('install')
    .description('Resolve targets and generate/update lock file')
    .option('--targets <names...>', 'Specific targets to install')
    .option('--update', 'Update existing lock (re-resolve selectors)')
    .option('--no-fetch', 'Skip fetching registry updates')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      console.log(chalk.blue('Installing...'))

      try {
        const result = await install({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: options.targets,
          update: options.update,
          fetchRegistry: options.fetch !== false,
        })

        // Report results
        console.log('')
        console.log(chalk.green('Installation complete'))
        console.log(`  Targets resolved: ${result.resolvedTargets.join(', ')}`)
        console.log(`  Snapshots created: ${result.snapshotsCreated}`)
        console.log(`  Lock file: ${result.lockPath}`)
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
