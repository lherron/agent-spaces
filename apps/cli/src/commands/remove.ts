/**
 * Remove command - Remove space from target in asp-targets.toml.
 *
 * WHY: Allows users to remove spaces from targets without manually
 * editing TOML files. Automatically runs install after.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import {
  TARGETS_FILENAME,
  atomicWrite,
  parseSpaceRef,
  readTargetsToml,
  updateTargetComposeToml,
} from 'spaces-config'
import { install } from 'spaces-execution'

import { type CommonOptions, exitWithAspError, getProjectContext } from '../helpers.js'

interface RemoveOptions extends CommonOptions {
  target: string
  install: boolean
}

/**
 * True when a compose ref matches the argument: the exact ref, or a bare space
 * id equal to the ref's parsed id in any form (`space:<id>@sel`,
 * `space:project:<id>`, `space:agent:<id>`, ...).
 */
function refMatches(ref: string, spaceIdOrRef: string): boolean {
  if (ref === spaceIdOrRef) return true
  try {
    return parseSpaceRef(ref).id === spaceIdOrRef
  } catch {
    return false
  }
}

/**
 * Register the remove command.
 */
export function registerRemoveCommand(program: Command): void {
  program
    .command('remove')
    .description('Remove a space from a target')
    .argument('<spaceId>', 'Space ID or full space ref to remove (e.g., my-space)')
    .requiredOption('--target <name>', 'Target to remove the space from')
    .option('--no-install', 'Skip running install after removing')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options: RemoveOptions) => {
      try {
        const ctx = await getProjectContext(options)
        const targetsPath = join(ctx.projectPath, TARGETS_FILENAME)
        const manifest = await readTargetsToml(targetsPath)
        const original = await readFile(targetsPath, 'utf8')

        const targetName = options.target
        const target = manifest.targets[targetName]
        if (!target) {
          throw new Error(
            `Target "${targetName}" not found. Available: ${Object.keys(manifest.targets).join(', ')}`
          )
        }

        const compose = target.compose ?? []
        const nextCompose = compose.filter((ref) => !refMatches(ref, spaceId))

        if (nextCompose.length === compose.length) {
          throw new Error(`Space "${spaceId}" not found in target "${targetName}"`)
        }

        if (nextCompose.length === 0) {
          throw new Error(
            'Cannot remove last space from target. Targets must have at least one space.'
          )
        }

        const edit = updateTargetComposeToml(original, targetName, nextCompose)
        await atomicWrite(targetsPath, edit.toml)
        if (!edit.preserved) {
          console.log(
            chalk.yellow(`Rewrote ${TARGETS_FILENAME} in full; its comments were not preserved`)
          )
        }
        const removed = compose.length - nextCompose.length
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
        exitWithAspError(error, options)
      }
    })
}
