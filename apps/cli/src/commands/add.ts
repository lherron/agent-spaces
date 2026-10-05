/**
 * Add command - Add space ref to target in asp-targets.toml.
 *
 * WHY: Allows users to add spaces to targets without manually
 * editing TOML files. Automatically runs install after.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import { CliUsageError } from 'cli-kit'
import type { Command } from 'commander'

import {
  type SpaceRefString,
  TARGETS_FILENAME,
  atomicWrite,
  isSpaceRefString,
  readTargetsToml,
  resolveComposeRefs,
  updateTargetComposeToml,
} from 'spaces-config'
import { install } from 'spaces-execution'

import { exitWithAspError, printNoProjectError } from '../helpers.js'
import { findProjectRoot } from '../lib.js'

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
        printNoProjectError()
        process.exit(1)
      }

      const targetName = options.target
      const targetsPath = join(projectPath, TARGETS_FILENAME)

      try {
        // Load current manifest
        const manifest = await readTargetsToml(targetsPath)
        const original = await readFile(targetsPath, 'utf8')

        // Check if target exists
        if (!manifest.targets[targetName]) {
          throw new CliUsageError(
            `Target "${targetName}" not found\nAvailable targets: ${Object.keys(manifest.targets).join(', ')}`
          )
        }
        if (!isSpaceRefString(spaceRef)) {
          throw new CliUsageError(`Invalid space reference: "${spaceRef}"`)
        }

        // Check if space already in compose
        const compose = manifest.targets[targetName].compose ?? []
        if (compose.includes(spaceRef)) {
          console.log(chalk.yellow(`Space "${spaceRef}" already in target "${targetName}"`))
          process.exit(0)
        }
        const nextCompose = [...compose, spaceRef as SpaceRefString]

        // Resolve before writing so a bad ref never lands in the file
        await resolveComposeRefs(nextCompose, {
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
        })

        // Write updated manifest, editing only the compose list
        const edit = updateTargetComposeToml(original, targetName, nextCompose)
        await atomicWrite(targetsPath, edit.toml)
        if (!edit.preserved) {
          console.log(
            chalk.yellow(`Rewrote ${TARGETS_FILENAME} in full; its comments were not preserved`)
          )
        }

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
        exitWithAspError(error, options)
      }
    })
}
