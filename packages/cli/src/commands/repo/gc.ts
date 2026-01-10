/**
 * Repo GC command - Registry-level garbage collection.
 *
 * WHY: Maintains registry repo health and cleans up global-level
 * unreferenced entries. Complements project-level `asp gc`.
 */

import chalk from 'chalk'
import type { Command } from 'commander'
import { rm, stat } from 'node:fs/promises'

import { lockFileExists, readLockJson } from '@agent-spaces/core'
import { gitExec } from '@agent-spaces/git'
import { type GCOptions, PathResolver, getAspHome, runGC } from '@agent-spaces/store'

/**
 * Register the repo gc command.
 */
export function registerRepoGcCommand(repo: Command): void {
  repo
    .command('gc')
    .description('Run garbage collection on the registry repository')
    .option('--dry-run', 'Show what would be done without actually doing it')
    .option('--prune-global-lock', 'Also clean up global lock file entries')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })

      console.log(chalk.blue('Running repository garbage collection...'))
      console.log(`  Registry: ${paths.repo}`)
      console.log('')

      try {
        // Check if repo exists
        try {
          await stat(paths.repo)
        } catch {
          console.error(chalk.red('Registry not found. Run `asp repo init` first.'))
          process.exit(1)
        }

        // Run git gc on the registry
        console.log(chalk.cyan('Running git gc on registry...'))
        if (!options.dryRun) {
          await gitExec(['gc', '--auto'], { cwd: paths.repo })
        } else {
          console.log(chalk.yellow('  (dry run - would run: git gc --auto)'))
        }
        console.log(chalk.green('  Git garbage collection complete'))
        console.log('')

        // Prune global lock if requested
        if (options.pruneGlobalLock) {
          console.log(chalk.cyan('Pruning global lock file...'))
          const globalLockPath = paths.globalLock

          if (await lockFileExists(globalLockPath)) {
            if (!options.dryRun) {
              // For now, just delete the global lock - it will be regenerated on next global run
              await rm(globalLockPath)
              console.log(chalk.green('  Global lock file removed'))
            } else {
              console.log(chalk.yellow('  (dry run - would remove global lock file)'))
            }
          } else {
            console.log(chalk.gray('  No global lock file found'))
          }
          console.log('')
        }

        // Run store/cache GC with global lock included
        console.log(chalk.cyan('Running store/cache garbage collection...'))

        // Collect all lock files (including global lock)
        const lockFiles = []

        // Add global lock if it exists
        if (await lockFileExists(paths.globalLock)) {
          try {
            const globalLock = await readLockJson(paths.globalLock)
            lockFiles.push(globalLock)
          } catch {
            // Ignore corrupt global lock
          }
        }

        const gcOptions: GCOptions = {
          paths,
          cwd: paths.repo,
          dryRun: options.dryRun,
        }

        const result = await runGC(lockFiles, gcOptions)

        if (options.dryRun) {
          console.log(chalk.yellow('  (dry run - no files deleted)'))
        }

        console.log(chalk.green('  Store/cache garbage collection complete'))
        console.log(`    Snapshots removed: ${result.snapshotsDeleted}`)
        console.log(`    Cache entries removed: ${result.cacheEntriesDeleted}`)
        console.log(`    Space freed: ${formatBytes(result.bytesFreed)}`)
        console.log('')

        console.log(chalk.green('Repository garbage collection complete'))
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

/**
 * Format bytes as human-readable string.
 */
function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`
}
