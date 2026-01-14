/**
 * GC command - Garbage collect unreferenced store/cache entries.
 *
 * WHY: Over time, the store accumulates snapshots that are no longer
 * referenced by any lock file. This command cleans them up.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { readLockJson } from 'spaces-core'
import { type GCOptions, PathResolver, getAspHome, runGC } from 'spaces-store'

import { findProjectRoot } from '../index.js'

/**
 * Register the gc command.
 */
export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description('Garbage collect unreferenced store and cache entries')
    .option('--dry-run', 'Show what would be deleted without actually deleting')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })

      console.log(chalk.blue('Running garbage collection...'))
      console.log(`  Store: ${paths.store}`)
      console.log(`  Cache: ${paths.cache}`)
      console.log('')

      try {
        // Find project root
        const projectPath = options.project ?? (await findProjectRoot())

        // Load lock files from project (if found)
        const lockFiles = []
        if (projectPath) {
          try {
            const lock = await readLockJson(projectPath)
            lockFiles.push(lock)
          } catch {
            // No lock file, that's ok
          }
        }

        const gcOptions: GCOptions = {
          paths,
          cwd: paths.repo,
          dryRun: options.dryRun,
        }

        const result = await runGC(lockFiles, gcOptions)

        if (options.dryRun) {
          console.log(chalk.yellow('Dry run - no files deleted'))
          console.log('')
        }

        console.log(chalk.green('Garbage collection complete'))
        console.log(`  Snapshots removed: ${result.snapshotsDeleted}`)
        console.log(`  Cache entries removed: ${result.cacheEntriesDeleted}`)
        console.log(`  Space freed: ${formatBytes(result.bytesFreed)}`)
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
