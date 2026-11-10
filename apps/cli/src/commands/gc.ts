/**
 * GC command - Garbage collect unreferenced store/cache entries, and retire
 * unused scope roots.
 *
 * WHY: Over time, the store accumulates snapshots that are no longer
 * referenced by any lock file, and codex-homes accumulates scope roots no
 * agent uses. This command cleans them up.
 *
 * Roots are the project's asp-lock.json and <ASP_HOME>/global-lock.json.
 * Other projects' locks are not discoverable (nothing records the lock it was
 * built from), so snapshots and cache entries are collected only when
 * --project-only declares the loaded locks the whole root set.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import {
  DEFAULT_SCOPE_ROOT_MIN_AGE_DAYS,
  type GCOptions,
  type GCRootLock,
  OTHER_PROJECT_LOCKS_NONE_REASON,
  type ScopeRootDecision,
  loadGCRoots,
  retireScopeRoots,
  runGC,
} from 'spaces-config'

import { exitWithAspError, formatBytes, resolvePaths } from '../helpers.js'
import { findProjectRoot } from '../lib.js'

function describeRoot(label: string, root: GCRootLock | { none: string }): string {
  if ('lock' in root && root.lock) {
    const spaces = Object.keys(root.lock.spaces).length
    const targets = Object.keys(root.lock.targets).length
    return `  ${label}: ${root.path} (${spaces} spaces, ${targets} targets)`
  }
  return `  ${label}: none: ${root.none}`
}

function parseMinAgeDays(value: string): number {
  const days = Number(value)
  if (!Number.isFinite(days) || days < 0) {
    throw new Error(`--min-age-days must be a non-negative number, got ${JSON.stringify(value)}`)
  }
  return days
}

function scopeRootLine(decision: ScopeRootDecision, dryRun: boolean): string {
  const verb = decision.retire ? (dryRun ? 'would retire' : 'retired') : `kept (${decision.reason})`
  const error = decision.error ? ` FAILED: ${decision.error}` : ''
  return `  ${verb.padEnd(26)} ${formatBytes(decision.bytes).padStart(10)}  ${decision.name}  ${decision.detail}${error}`
}

/**
 * Register the gc command.
 */
export function registerGcCommand(program: Command): void {
  program
    .command('gc')
    .description(
      'Garbage collect unreferenced store and cache entries, and retire unused scope roots'
    )
    .option('--dry-run', 'Show what would be deleted without actually deleting')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option(
      '--project-only',
      'Collect snapshots and cache entries against the project and global locks alone, deleting what other projects reference'
    )
    .option('--scope-roots', 'Also retire unused scope roots under codex-homes')
    .option(
      '--min-age-days <days>',
      'Scope roots newer than this are kept',
      parseMinAgeDays,
      DEFAULT_SCOPE_ROOT_MIN_AGE_DAYS
    )
    .action(async (options) => {
      const { paths } = resolvePaths(options)
      const dryRun = Boolean(options.dryRun)

      console.log(chalk.blue('Running garbage collection...'))
      console.log(`  Store: ${paths.snapshots}`)
      console.log(`  Cache: ${paths.cache}`)
      console.log('')

      try {
        const projectPath = options.project ?? (await findProjectRoot())
        // Refuses, before anything is deleted, when a lock exists but cannot be read.
        const roots = await loadGCRoots({ paths, projectPath })
        const collectStore = Boolean(options.projectOnly)

        console.log('Roots:')
        console.log(describeRoot('project lock', roots.project))
        console.log(describeRoot('global lock', roots.global))
        console.log(
          collectStore
            ? '  other project locks: not consulted (--project-only)'
            : `  other project locks: none: ${OTHER_PROJECT_LOCKS_NONE_REASON}`
        )
        console.log(
          collectStore
            ? '  snapshots and cache entries: collected against the locks above (--project-only)'
            : '  snapshots and cache entries: kept (other project locks are not discoverable; --project-only collects against the locks above)'
        )
        console.log('')

        const gcOptions: GCOptions = {
          paths,
          cwd: paths.repo,
          dryRun,
          collectStore,
        }

        const result = await runGC(roots.lockFiles, gcOptions)

        const scopeRoots = options.scopeRoots
          ? await retireScopeRoots({
              aspHome: paths.aspHome,
              minAgeDays: options.minAgeDays,
              dryRun,
            })
          : undefined

        if (scopeRoots) {
          console.log(`Scope roots (${paths.aspHome}/codex-homes, min age ${options.minAgeDays}d):`)
          for (const decision of scopeRoots.decisions) {
            console.log(scopeRootLine(decision, dryRun))
          }
          console.log('')
        }

        if (dryRun) {
          console.log(chalk.yellow('Dry run - no files deleted'))
          console.log('')
        }

        console.log(chalk.green('Garbage collection complete'))
        console.log(`  Snapshots removed: ${result.snapshotsDeleted}`)
        console.log(`  Cache entries removed: ${result.cacheEntriesDeleted}`)
        console.log(`  Bundle versions removed: ${result.bundleVersionsDeleted}`)
        console.log(`  Space freed: ${formatBytes(result.bytesFreed)}`)
        if (scopeRoots) {
          const verb = dryRun ? 'would retire' : 'retired'
          const bucket = (reason: keyof typeof scopeRoots.counts) =>
            `${scopeRoots.counts[reason]} (${formatBytes(scopeRoots.bytes[reason])})`
          console.log(`  Scope roots scanned: ${scopeRoots.decisions.length}`)
          console.log(`    kept by live reference: ${bucket('live')}`)
          console.log(`    kept by age: ${bucket('age')}`)
          console.log(`    kept not a scope root: ${bucket('not-scope-root')}`)
          console.log(`    ${verb}: ${bucket('retire')}`)
          if (scopeRoots.errors)
            console.log(chalk.red(`    failed to retire: ${scopeRoots.errors}`))
          if (scopeRoots.errors) process.exitCode = 1
        }
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
