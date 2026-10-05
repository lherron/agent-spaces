/**
 * Repo status command - Show the shared spaces root.
 *
 * WHY: Gives one view of where shared spaces live, which spaces are there,
 * and any uncommitted edits under spaces/ when the root is a git checkout.
 */

import { readdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { gitExec, gitExecLines } from 'spaces-config'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { spacesDirExists } from '../spaces/scaffold.js'

interface SpacesGitState {
  branch: string
  /** `git status --porcelain` lines scoped to spaces/. */
  changes: string[]
}

interface SpacesRootStatus {
  spacesRoot: string
  spaces: string[]
  /** Null when the root is not inside a git checkout. */
  git: SpacesGitState | null
}

async function listSpaces(root: string): Promise<string[]> {
  const entries = await readdir(`${root}/spaces`, { withFileTypes: true })
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

async function readGitState(root: string): Promise<SpacesGitState | null> {
  try {
    const [branch] = await gitExecLines(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })
    // Raw stdout, not gitExecLines: trimming would eat the porcelain XY column.
    const { stdout } = await gitExec(['status', '--porcelain', '--', 'spaces/'], { cwd: root })
    const changes = stdout.split('\n').filter((line) => line.length > 0)
    return { branch: branch ?? '(unknown)', changes }
  } catch {
    return null
  }
}

function formatStatusText(status: SpacesRootStatus): void {
  console.log(chalk.blue('Shared spaces root'))
  console.log('')
  console.log(`  Path: ${status.spacesRoot}`)
  if (status.git) {
    const state = status.git.changes.length === 0 ? chalk.green('clean') : chalk.yellow('modified')
    console.log(`  Branch: ${status.git.branch}`)
    console.log(`  spaces/: ${state}`)
    for (const line of status.git.changes) {
      console.log(`    ${line}`)
    }
  } else {
    console.log(`  Git: ${chalk.gray('not a git checkout')}`)
  }

  console.log('')
  console.log(chalk.blue('Spaces'))
  if (status.spaces.length === 0) {
    console.log(chalk.gray('  No spaces found'))
    return
  }
  for (const space of status.spaces) {
    console.log(`  ${space}`)
  }
}

/**
 * Register the repo status command.
 */
export function registerRepoStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show the shared spaces root and its spaces')
    .option('--json', 'Output as JSON')
    .option('--registry <path>', 'Shared spaces root override (default: agents root)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      try {
        const { registryPath } = resolvePaths(options)

        if (!(await spacesDirExists(registryPath))) {
          console.error(chalk.red(`No shared spaces dir at ${registryPath}/spaces`))
          console.error(chalk.gray('Run "asp repo init" to create it'))
          process.exit(1)
        }

        const status: SpacesRootStatus = {
          spacesRoot: registryPath,
          spaces: await listSpaces(registryPath),
          git: await readGitState(registryPath),
        }

        if (options.json) {
          console.log(JSON.stringify(status, null, 2))
        } else {
          formatStatusText(status)
        }
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
