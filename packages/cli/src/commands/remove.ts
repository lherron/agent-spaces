/**
 * Remove command - Remove space from target in asp-targets.toml.
 *
 * WHY: Allows users to remove spaces from targets without manually
 * editing TOML files. Automatically runs install after.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { atomicWrite, readTargetsToml, serializeTargetsToml } from '@agent-spaces/core'
import { install } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the remove command.
 */
export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('Remove a space from a target')
    .argument('<spaceId>', 'Space ID to remove (e.g., my-space)')
    .requiredOption('--target <name>', 'Target to remove the space from')
    .option('--no-install', 'Skip running install after removing')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options) => {
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

        // Find and remove matching space refs
        const target = manifest.targets[targetName]
        const originalLength = target.compose.length

        // Match by space ID (the part after "space:" and before "@")
        target.compose = target.compose.filter((ref) => {
          // Parse space:id@selector format
          const match = ref.match(/^space:([^@]+)@/)
          const refId = match ? match[1] : ref
          return refId !== spaceId
        })

        if (target.compose.length === originalLength) {
          console.log(chalk.yellow(`Space "${spaceId}" not found in target "${targetName}"`))
          process.exit(0)
        }

        // Ensure target still has at least one space
        if (target.compose.length === 0) {
          console.error(chalk.red('Error: Cannot remove last space from target'))
          console.error(chalk.gray('Targets must have at least one space in compose'))
          process.exit(1)
        }

        // Write updated manifest
        const toml = serializeTargetsToml(manifest)
        await atomicWrite(targetsPath, toml)

        const removed = originalLength - target.compose.length
        console.log(
          chalk.green(`Removed ${removed} reference(s) to "${spaceId}" from target "${targetName}"`)
        )

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
