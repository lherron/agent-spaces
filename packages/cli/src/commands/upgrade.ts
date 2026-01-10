/**
 * Upgrade command - Update lock pins per selectors.
 *
 * WHY: Allows users to update their lock file to the latest
 * versions matching their selectors without changing asp-targets.toml.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { install } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the upgrade command.
 */
export function registerUpgradeCommand(program: Command): void {
  program
    .command('upgrade')
    .description('Update lock file pins to latest versions matching selectors')
    .argument('[spaceIds...]', 'Specific spaces to upgrade (default: all)')
    .option('--target <name>', 'Limit to specific target')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceIds: string[], options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      try {
        console.log(chalk.blue('Upgrading...'))
        if (spaceIds.length > 0) {
          console.log(`  Spaces: ${spaceIds.join(', ')}`)
        }
        if (options.target) {
          console.log(`  Target: ${options.target}`)
        }

        // Run install with update=true to re-resolve selectors
        // When spaceIds are specified, only those spaces are upgraded (others stay at locked versions)
        const result = await install({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: options.target ? [options.target] : undefined,
          update: true,
          fetchRegistry: true,
          upgradeSpaceIds: spaceIds.length > 0 ? spaceIds : undefined,
        })

        console.log('')
        console.log(chalk.green('Upgrade complete'))
        if (spaceIds.length > 0) {
          console.log(`  Spaces upgraded: ${spaceIds.join(', ')}`)
        }
        console.log(`  Targets updated: ${result.resolvedTargets.join(', ')}`)
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
