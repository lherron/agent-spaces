/**
 * Diff command - Show pending lock changes without writing.
 *
 * WHY: Allows users to preview what would change in the lock file
 * before actually running install or upgrade.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type LockFile, lockFileExists, readLockJson, readTargetsToml } from '@agent-spaces/core'
import { type ResolveOptions, resolveTarget } from '@agent-spaces/engine'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

/**
 * Represents a single change in a diff.
 */
interface DiffChange {
  spaceId: string
  type: 'added' | 'removed' | 'updated'
  from?: string | undefined
  to?: string | undefined
}

/**
 * Represents diffs for a single target.
 */
interface TargetDiff {
  target: string
  changes: DiffChange[]
}

/**
 * Space info extracted from lock entries.
 */
interface SpaceInfo {
  commit: string
  version: string | undefined
}

/**
 * Build a map of space ID to commit/version info from lock file.
 */
function buildSpacesMap(lock: LockFile | null, targetName: string): Map<string, SpaceInfo> {
  const result = new Map<string, SpaceInfo>()
  const target = lock?.targets[targetName]
  if (!target || !lock) return result

  for (const key of target.loadOrder) {
    const entry = lock.spaces[key]
    if (entry) {
      result.set(entry.id as string, {
        commit: entry.commit as string,
        version: entry.plugin.version,
      })
    }
  }
  return result
}

/**
 * Compute diff changes between current and fresh space maps.
 */
function computeDiffChanges(
  currentSpaces: Map<string, SpaceInfo>,
  freshSpaces: Map<string, SpaceInfo>
): DiffChange[] {
  const changes: DiffChange[] = []

  // Find added and updated spaces
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

  // Find removed spaces
  for (const [id, current] of currentSpaces) {
    if (!freshSpaces.has(id)) {
      changes.push({
        spaceId: id,
        type: 'removed',
        from: current.version ?? current.commit.slice(0, 12),
      })
    }
  }

  return changes
}

/**
 * Format diff output as text.
 */
function formatDiffText(diffs: TargetDiff[]): void {
  if (diffs.length === 0) {
    console.log(chalk.green('No changes detected'))
    return
  }

  for (const diff of diffs) {
    console.log(chalk.blue(`Target: ${diff.target}`))
    for (const change of diff.changes) {
      formatChangeText(change)
    }
    console.log('')
  }
}

/**
 * Format a single change as text.
 */
function formatChangeText(change: DiffChange): void {
  switch (change.type) {
    case 'added':
      console.log(chalk.green(`  + ${change.spaceId} ${change.to}`))
      break
    case 'removed':
      console.log(chalk.red(`  - ${change.spaceId} ${change.from}`))
      break
    case 'updated':
      console.log(chalk.yellow(`  ~ ${change.spaceId} ${change.from} -> ${change.to}`))
      break
  }
}

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
    .action(async (options: CommonOptions & { target?: string }) => {
      try {
        const ctx = await getProjectContext(options)
        const diffs = await computeAllDiffs(ctx, options)
        outputDiffs(diffs, options)
      } catch (error) {
        handleCliError(error)
      }
    })
}

/**
 * Compute diffs for all requested targets.
 */
async function computeAllDiffs(
  ctx: { projectPath: string; aspHome: string; registryPath: string },
  options: { target?: string | undefined }
): Promise<TargetDiff[]> {
  // Load current lock file
  const hasLock = await lockFileExists(ctx.projectPath)
  const currentLock = hasLock ? await readLockJson(ctx.projectPath) : null

  // Load manifest
  const manifest = await readTargetsToml(`${ctx.projectPath}/asp-targets.toml`)
  const targetNames = options.target ? [options.target] : Object.keys(manifest.targets)

  // Validate target exists
  if (options.target && !manifest.targets[options.target]) {
    throw new Error(`Target "${options.target}" not found`)
  }

  // Resolve fresh (without using lock)
  const resolveOpts: ResolveOptions = {
    projectPath: ctx.projectPath,
    aspHome: ctx.aspHome,
    registryPath: ctx.registryPath,
    useLock: false,
  }

  const diffs: TargetDiff[] = []

  for (const targetName of targetNames) {
    const currentSpaces = buildSpacesMap(currentLock, targetName)
    const result = await resolveTarget(targetName, resolveOpts)
    const freshSpaces = buildSpacesMap(result.lock, targetName)
    const changes = computeDiffChanges(currentSpaces, freshSpaces)

    if (changes.length > 0) {
      diffs.push({ target: targetName, changes })
    }
  }

  return diffs
}

/**
 * Output diffs in requested format.
 */
function outputDiffs(diffs: TargetDiff[], options: { json?: boolean | undefined }): void {
  if (options.json) {
    console.log(JSON.stringify({ diffs }, null, 2))
  } else {
    formatDiffText(diffs)
  }
}
