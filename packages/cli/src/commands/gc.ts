/**
 * GC command - Garbage collect unreferenced store/cache entries.
 *
 * WHY: Over time, the store accumulates snapshots that are no longer
 * referenced by any lock file. This command cleans them up.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type GCOptions, readLockJson, runGC } from 'spaces-config'

import { errorMessage, formatBytes, resolvePaths } from '../helpers.js'
import { findProjectRoot } from '../lib.js'

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
      const { paths } = resolvePaths(options)

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
        console.log(`  Bundle versions removed: ${result.bundleVersionsDeleted}`)
        console.log(`  Space freed: ${formatBytes(result.bytesFreed)}`)
      } catch (error) {
        console.error(chalk.red(`Error: ${errorMessage(error)}`))
        process.exit(1)
      }
    })
}
