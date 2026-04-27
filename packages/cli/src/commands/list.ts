/**
 * List command - List targets, resolved spaces, cached environments.
 *
 * WHY: Provides overview of available targets and their status,
 * helping users understand what can be run.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type LockFile, loadLockFileIfExists, loadProjectManifest } from 'spaces-config'

import { type CommonOptions, exitWithAspError, getProjectContext } from '../helpers.js'

interface TargetInfo {
  name: string
  description: string | undefined
  compose: string[]
  locked: boolean
  envHash: string | undefined
  spaceCount: number
}

interface ListOutput {
  projectPath: string
  targets: TargetInfo[]
  hasLock: boolean
  lockGenerated: string | undefined
  aspHome: string
  storePath: string
  cachePath: string
}

/**
 * Build target info from manifest and lock file.
 */
function buildTargetInfo(
  name: string,
  manifest: Awaited<ReturnType<typeof loadProjectManifest>>,
  lock: LockFile | undefined
): TargetInfo {
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
}

/**
 * Format a single target for text display.
 */
function formatTargetText(target: TargetInfo): void {
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

/**
 * Format list output as text.
 */
function formatListText(output: ListOutput): void {
  console.log(chalk.blue('Targets:'))
  console.log('')
  for (const target of output.targets) {
    formatTargetText(target)
  }
  console.log(chalk.blue('Paths:'))
  console.log(`  Project: ${output.projectPath}`)
  console.log(`  ASP_HOME: ${output.aspHome}`)
  console.log(`  Store: ${output.storePath}`)
  console.log(`  Cache: ${output.cachePath}`)
}

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
    .action(async (options: CommonOptions) => {
      try {
        const ctx = await getProjectContext(options)
        const manifest = await loadProjectManifest(ctx.projectPath, ctx.aspHome)
        const targetNames = Object.keys(manifest.targets)

        const lock = await loadLockFileIfExists(ctx.projectPath)
        const hasLock = lock !== null

        const output: ListOutput = {
          projectPath: ctx.projectPath,
          targets: targetNames.map((name) => buildTargetInfo(name, manifest, lock ?? undefined)),
          hasLock,
          lockGenerated: lock?.generatedAt,
          aspHome: ctx.aspHome,
          storePath: ctx.paths.store,
          cachePath: ctx.paths.cache,
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatListText(output)
        }
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
