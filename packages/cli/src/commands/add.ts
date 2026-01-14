/**
 * Add command - Add space ref to target in asp-targets.toml.
 *
 * WHY: Allows users to add spaces to targets without manually
 * editing TOML files. Automatically runs install after.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import {
  type SpaceRefString,
  atomicWrite,
  readTargetsToml,
  serializeTargetsToml,
} from 'spaces-core'
import { install } from 'spaces-engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the add command.
 */
export function registerAddCommand(program: Command): void {
  program
    .command('add')
    .description('Add a space reference to a target')
    .argument('<spaceRef>', 'Space reference (e.g., space:my-space@stable)')
    .requiredOption('--target <name>', 'Target to add the space to')
    .option('--no-install', 'Skip running install after adding')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceRef: string, options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      const targetName = options.target
      const targetsPath = `${projectPath}/asp-targets.toml`

      try {
        // Load current manifest
        const manifest = await readTargetsToml(targetsPath)

        // Check if target exists
        if (!manifest.targets[targetName]) {
          console.error(chalk.red(`Error: Target "${targetName}" not found`))
          console.error(
            chalk.gray(`Available targets: ${Object.keys(manifest.targets).join(', ')}`)
          )
          process.exit(1)
        }

        // Check if space already in compose
        const target = manifest.targets[targetName]
        if (target.compose.includes(spaceRef as SpaceRefString)) {
          console.log(chalk.yellow(`Space "${spaceRef}" already in target "${targetName}"`))
          process.exit(0)
        }

        // Add space to compose
        target.compose.push(spaceRef as SpaceRefString)

        // Write updated manifest
        const toml = serializeTargetsToml(manifest)
        await atomicWrite(targetsPath, toml)

        console.log(chalk.green(`Added "${spaceRef}" to target "${targetName}"`))

        // Run install if requested
        if (options.install !== false) {
          console.log('')
          console.log(chalk.blue('Running install...'))

          const result = await install({
            projectPath,
            aspHome: options.aspHome,
            registryPath: options.registry,
            targets: [targetName],
          })

          console.log(chalk.green('Installation complete'))
          console.log(`  Snapshots created: ${result.snapshotsCreated}`)
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
