/**
 * Remove command - Remove space from target in asp-targets.toml.
 *
 * WHY: Allows users to remove spaces from targets without manually
 * editing TOML files. Automatically runs install after.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { atomicWrite, readTargetsToml, serializeTargetsToml } from 'spaces-core'
import { install } from 'spaces-engine'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

interface RemoveOptions extends CommonOptions {
  target: string
  install: boolean
}

/**
 * Extract space ID from a space reference.
 */
function extractSpaceId(ref: string): string {
  const match = ref.match(/^space:([^@]+)@/)
  return match?.[1] ?? ref
}

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
    .action(async (spaceId: string, options: RemoveOptions) => {
      try {
        const ctx = await getProjectContext(options)
        const targetsPath = `${ctx.projectPath}/asp-targets.toml`
        const manifest = await readTargetsToml(targetsPath)

        const targetName = options.target
        const target = manifest.targets[targetName]
        if (!target) {
          throw new Error(
            `Target "${targetName}" not found. Available: ${Object.keys(manifest.targets).join(', ')}`
          )
        }

        const originalLength = target.compose.length
        target.compose = target.compose.filter((ref) => extractSpaceId(ref) !== spaceId)

        if (target.compose.length === originalLength) {
          console.log(chalk.yellow(`Space "${spaceId}" not found in target "${targetName}"`))
          return
        }

        if (target.compose.length === 0) {
          throw new Error(
            'Cannot remove last space from target. Targets must have at least one space.'
          )
        }

        await atomicWrite(targetsPath, serializeTargetsToml(manifest))
        const removed = originalLength - target.compose.length
        console.log(
          chalk.green(`Removed ${removed} reference(s) to "${spaceId}" from target "${targetName}"`)
        )

        if (options.install !== false) {
          console.log('')
          console.log(chalk.blue('Running install...'))
          const result = await install({
            projectPath: ctx.projectPath,
            aspHome: ctx.aspHome,
            registryPath: ctx.registryPath,
            targets: [targetName],
          })
          console.log(chalk.green('Installation complete'))
          console.log(`  Snapshots created: ${result.snapshotsCreated}`)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
