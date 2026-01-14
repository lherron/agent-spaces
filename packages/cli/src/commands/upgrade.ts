/**
 * Upgrade command - Update lock pins per selectors.
 *
 * WHY: Allows users to update their lock file to the latest
 * versions matching their selectors without changing asp-targets.toml.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { install } from 'spaces-engine'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

interface UpgradeOptions extends CommonOptions {
  target?: string | undefined
}

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
    .action(async (spaceIds: string[], options: UpgradeOptions) => {
      try {
        const ctx = await getProjectContext(options)

        console.log(chalk.blue('Upgrading...'))
        if (spaceIds.length > 0) {
          console.log(`  Spaces: ${spaceIds.join(', ')}`)
        }
        if (options.target) {
          console.log(`  Target: ${options.target}`)
        }

        const result = await install({
          projectPath: ctx.projectPath,
          aspHome: ctx.aspHome,
          registryPath: ctx.registryPath,
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
        handleCliError(error)
      }
    })
}
