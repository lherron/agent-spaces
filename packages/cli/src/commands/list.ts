/**
 * List command - List targets, resolved spaces, cached environments.
 *
 * WHY: Provides overview of available targets and their status,
 * helping users understand what can be run.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type LockFile, lockFileExists, readLockJson, readTargetsToml } from '@agent-spaces/core'
import { PathResolver, getAspHome } from '@agent-spaces/store'

import { findProjectRoot } from '../index.js'

/**
 * Register the list command.
 */
export function registerListCommand(program: Command): void {
  program
    .command('list')
    .description('List targets, resolved spaces, and cached environments')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      try {
        // Load project manifest
        const manifest = await readTargetsToml(`${projectPath}/asp-targets.toml`)
        const targetNames = Object.keys(manifest.targets)

        // Check for lock file
        const hasLock = await lockFileExists(projectPath)
        let lock: LockFile | undefined
        if (hasLock) {
          lock = await readLockJson(projectPath)
        }

        // Get cache info
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        const output = {
          projectPath,
          targets: targetNames.map((name) => {
            const target = manifest.targets[name]
            const lockTarget = lock?.targets[name]
            return {
              name,
              description: target?.description,
              compose: target?.compose ?? [],
              locked: !!lockTarget,
              envHash: lockTarget?.envHash,
              spaceCount: lockTarget?.loadOrder.length ?? 0,
            }
          }),
          hasLock,
          lockGenerated: lock?.generatedAt,
          aspHome,
          storePath: paths.store,
          cachePath: paths.cache,
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          console.log(chalk.blue('Targets:'))
          console.log('')
          for (const target of output.targets) {
            const status = target.locked ? chalk.green('(locked)') : chalk.yellow('(unlocked)')
            console.log(`  ${chalk.bold(target.name)} ${status}`)
            if (target.description) {
              console.log(`    ${chalk.gray(target.description)}`)
            }
            console.log(`    Compose: ${target.compose.join(', ')}`)
            if (target.locked) {
              console.log(`    Spaces: ${target.spaceCount}`)
              console.log(`    Env hash: ${target.envHash?.slice(0, 16)}...`)
            }
            console.log('')
          }

          console.log(chalk.blue('Paths:'))
          console.log(`  Project: ${output.projectPath}`)
          console.log(`  ASP_HOME: ${output.aspHome}`)
          console.log(`  Store: ${output.storePath}`)
          console.log(`  Cache: ${output.cachePath}`)
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
