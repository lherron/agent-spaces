/**
 * Repo GC command - Registry-level garbage collection.
 *
 * WHY: Maintains registry repo health and cleans up global-level
 * unreferenced entries. Complements project-level `asp gc`.
 */

import { rm, stat } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { type LockFile, lockFileExists, readLockJson } from 'spaces-core'
import { gitExec } from 'spaces-git'
import { type GCOptions, PathResolver, getAspHome, runGC } from 'spaces-store'

import { handleCliError } from '../../helpers.js'

interface RepoGcOptions {
  dryRun?: boolean | undefined
  pruneGlobalLock?: boolean | undefined
  aspHome?: string | undefined
}

/**
 * Check if registry exists at the given path.
 */
async function ensureRegistryExists(repoPath: string): Promise<void> {
  try {
    await stat(repoPath)
  } catch {
    throw new Error('Registry not found. Run `asp repo init` first.')
  }
}

/**
 * Run git gc on the registry.
 */
async function runGitGc(repoPath: string, dryRun: boolean): Promise<void> {
  console.log(chalk.cyan('Running git gc on registry...'))
  if (dryRun) {
    console.log(chalk.yellow('  (dry run - would run: git gc --auto)'))
  } else {
    await gitExec(['gc', '--auto'], { cwd: repoPath })
  }
  console.log(chalk.green('  Git garbage collection complete'))
  console.log('')
}

/**
 * Prune global lock file if requested.
 */
async function pruneGlobalLock(globalLockPath: string, dryRun: boolean): Promise<void> {
  console.log(chalk.cyan('Pruning global lock file...'))
  if (await lockFileExists(globalLockPath)) {
    if (dryRun) {
      console.log(chalk.yellow('  (dry run - would remove global lock file)'))
    } else {
      await rm(globalLockPath)
      console.log(chalk.green('  Global lock file removed'))
    }
  } else {
    console.log(chalk.gray('  No global lock file found'))
  }
  console.log('')
}

/**
 * Collect lock files for GC.
 */
async function collectLockFiles(globalLockPath: string): Promise<LockFile[]> {
  const lockFiles: LockFile[] = []
  if (await lockFileExists(globalLockPath)) {
    try {
      lockFiles.push(await readLockJson(globalLockPath))
    } catch {
      // Ignore corrupt global lock
    }
  }
  return lockFiles
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
    .action(async (options: RepoGcOptions) => {
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })
      const dryRun = options.dryRun ?? false

      console.log(chalk.blue('Running repository garbage collection...'))
      console.log(`  Registry: ${paths.repo}`)
      console.log('')

      try {
        await ensureRegistryExists(paths.repo)
        await runGitGc(paths.repo, dryRun)

        if (options.pruneGlobalLock) {
          await pruneGlobalLock(paths.globalLock, dryRun)
        }

        console.log(chalk.cyan('Running store/cache garbage collection...'))
        const lockFiles = await collectLockFiles(paths.globalLock)
        const gcOptions: GCOptions = { paths, cwd: paths.repo, dryRun }
        const result = await runGC(lockFiles, gcOptions)

        if (dryRun) {
          console.log(chalk.yellow('  (dry run - no files deleted)'))
        }
        console.log(chalk.green('  Store/cache garbage collection complete'))
        console.log(`    Snapshots removed: ${result.snapshotsDeleted}`)
        console.log(`    Cache entries removed: ${result.cacheEntriesDeleted}`)
        console.log(`    Space freed: ${formatBytes(result.bytesFreed)}`)
        console.log('')
        console.log(chalk.green('Repository garbage collection complete'))
      } catch (error) {
        handleCliError(error)
      }
    })
}
