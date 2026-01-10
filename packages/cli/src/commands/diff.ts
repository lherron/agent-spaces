/**
 * Diff command - Show pending lock changes without writing.
 *
 * WHY: Allows users to preview what would change in the lock file
 * before actually running install or upgrade.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { lockFileExists, readLockJson, readTargetsToml } from '@agent-spaces/core'
import { type ResolveOptions, resolveTarget } from '@agent-spaces/engine'
import { PathResolver, getAspHome } from '@agent-spaces/store'

import { findProjectRoot } from '../index.js'

/**
 * Register the diff command.
 */
export function registerDiffCommand(program: Command): void {
  program
    .command('diff')
    .description('Show pending lock changes without writing')
    .option('--target <name>', 'Specific target to check')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
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
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        // Load current lock file
        const hasLock = await lockFileExists(projectPath)
        const currentLock = hasLock ? await readLockJson(projectPath) : null

        // Load manifest
        const manifest = await readTargetsToml(`${projectPath}/asp-targets.toml`)
        const targetNames = options.target ? [options.target] : Object.keys(manifest.targets)

        // Check if target exists
        if (options.target && !manifest.targets[options.target]) {
          console.error(chalk.red(`Error: Target "${options.target}" not found`))
          process.exit(1)
        }

        // Resolve fresh (without using lock)
        const resolveOpts: ResolveOptions = {
          projectPath,
          aspHome,
          registryPath: options.registry ?? paths.repo,
          useLock: false,
        }

        const diffs: Array<{
          target: string
          changes: Array<{
            spaceId: string
            type: 'added' | 'removed' | 'updated'
            from?: string | undefined
            to?: string | undefined
          }>
        }> = []

        for (const targetName of targetNames) {
          const changes: (typeof diffs)[0]['changes'] = []

          // Get current lock entries for this target
          const currentTarget = currentLock?.targets[targetName]
          const currentSpaces = new Map<string, { commit: string; version: string | undefined }>()
          if (currentTarget) {
            for (const key of currentTarget.loadOrder) {
              const entry = currentLock?.spaces[key]
              if (entry) {
                currentSpaces.set(entry.id as string, {
                  commit: entry.commit as string,
                  version: entry.plugin.version,
                })
              }
            }
          }

          // Resolve fresh
          const result = await resolveTarget(targetName, resolveOpts)
          const freshSpaces = new Map<string, { commit: string; version: string | undefined }>()
          for (const key of result.lock.targets[targetName]?.loadOrder ?? []) {
            const entry = result.lock.spaces[key]
            if (entry) {
              freshSpaces.set(entry.id as string, {
                commit: entry.commit as string,
                version: entry.plugin.version,
              })
            }
          }

          // Compare
          for (const [id, fresh] of freshSpaces) {
            const current = currentSpaces.get(id)
            if (!current) {
              changes.push({
                spaceId: id,
                type: 'added',
                to: fresh.version ?? fresh.commit.slice(0, 12),
              })
            } else if (current.commit !== fresh.commit) {
              changes.push({
                spaceId: id,
                type: 'updated',
                from: current.version ?? current.commit.slice(0, 12),
                to: fresh.version ?? fresh.commit.slice(0, 12),
              })
            }
          }

          for (const [id, current] of currentSpaces) {
            if (!freshSpaces.has(id)) {
              changes.push({
                spaceId: id,
                type: 'removed',
                from: current.version ?? current.commit.slice(0, 12),
              })
            }
          }

          if (changes.length > 0) {
            diffs.push({ target: targetName, changes })
          }
        }

        // Output
        if (options.json) {
          console.log(JSON.stringify({ diffs }, null, 2))
        } else {
          if (diffs.length === 0) {
            console.log(chalk.green('No changes detected'))
          } else {
            for (const diff of diffs) {
              console.log(chalk.blue(`Target: ${diff.target}`))
              for (const change of diff.changes) {
                if (change.type === 'added') {
                  console.log(chalk.green(`  + ${change.spaceId} ${change.to}`))
                } else if (change.type === 'removed') {
                  console.log(chalk.red(`  - ${change.spaceId} ${change.from}`))
                } else {
                  console.log(chalk.yellow(`  ~ ${change.spaceId} ${change.from} -> ${change.to}`))
                }
              }
              console.log('')
            }
          }
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
