/**
 * Repo status command - Show registry status.
 *
 * WHY: Provides visibility into the registry state, including
 * available spaces, tags, and any uncommitted changes.
 */

import { readdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { getStatus } from 'spaces-git'
import { PathResolver, getAspHome } from 'spaces-store'

import { handleCliError } from '../../helpers.js'

/**
 * Registry status output structure.
 */
interface RegistryStatus {
  repoPath: string
  branch: string | null
  clean: boolean
  modified: string[]
  staged: string[]
  untracked: string[]
  spaces: string[]
  distTags: Record<string, Record<string, string>>
}

/**
 * Check if registry exists and throw if not.
 */
async function ensureRegistryExists(repoPath: string): Promise<void> {
  const repoFile = Bun.file(`${repoPath}/.git/HEAD`)
  if (!(await repoFile.exists())) {
    console.error(chalk.red('No registry found'))
    console.error(chalk.gray(`Expected at: ${repoPath}`))
    console.error(chalk.gray('Run "asp repo init" to create one'))
    process.exit(1)
  }
}

/**
 * List available spaces in registry.
 */
async function listSpaces(repoPath: string): Promise<string[]> {
  try {
    const spacesDir = `${repoPath}/spaces`
    const entries = await readdir(spacesDir, { withFileTypes: true })
    return entries.filter((e) => e.isDirectory()).map((e) => e.name)
  } catch {
    return []
  }
}

/**
 * Load dist-tags from registry.
 */
async function loadDistTags(repoPath: string): Promise<Record<string, Record<string, string>>> {
  try {
    const distTagsPath = `${repoPath}/registry/dist-tags.json`
    const content = await Bun.file(distTagsPath).text()
    return JSON.parse(content)
  } catch {
    return {}
  }
}

/**
 * Format git status changes for text output.
 */
function formatGitChanges(status: RegistryStatus): void {
  if (status.staged.length > 0) {
    console.log('')
    console.log(chalk.green('  Staged:'))
    for (const file of status.staged) {
      console.log(`    ${file}`)
    }
  }

  if (status.modified.length > 0) {
    console.log('')
    console.log(chalk.yellow('  Modified:'))
    for (const file of status.modified) {
      console.log(`    ${file}`)
    }
  }

  if (status.untracked.length > 0) {
    console.log('')
    console.log(chalk.gray('  Untracked:'))
    for (const file of status.untracked) {
      console.log(`    ${file}`)
    }
  }
}

/**
 * Format spaces list for text output.
 */
function formatSpacesList(
  spaces: string[],
  distTags: Record<string, Record<string, string>>
): void {
  console.log('')
  console.log(chalk.blue('Spaces'))

  if (spaces.length === 0) {
    console.log(chalk.gray('  No spaces found'))
    return
  }

  for (const space of spaces) {
    const tags = distTags[space] ?? {}
    const tagList = Object.entries(tags)
      .map(([tag, version]) => `${tag}=${version}`)
      .join(', ')
    console.log(`  ${space}${tagList ? ` (${chalk.gray(tagList)})` : ''}`)
  }
}

/**
 * Format status output as text.
 */
function formatStatusText(status: RegistryStatus): void {
  console.log(chalk.blue('Registry Status'))
  console.log('')
  console.log(`  Path: ${status.repoPath}`)
  console.log(`  Branch: ${status.branch ?? '(detached)'}`)
  console.log(`  Status: ${status.clean ? chalk.green('clean') : chalk.yellow('modified')}`)

  if (!status.clean) {
    formatGitChanges(status)
  }

  formatSpacesList(status.spaces, status.distTags)
}

/**
 * Register the repo status command.
 */
export function registerRepoStatusCommand(parent: Command): void {
  parent
    .command('status')
    .description('Show registry status')
    .option('--json', 'Output as JSON')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        await ensureRegistryExists(paths.repo)

        const gitStatus = await getStatus({ cwd: paths.repo })
        const spaces = await listSpaces(paths.repo)
        const distTags = await loadDistTags(paths.repo)

        const status: RegistryStatus = {
          repoPath: paths.repo,
          branch: gitStatus.branch,
          clean: gitStatus.clean,
          modified: gitStatus.modified,
          staged: gitStatus.staged,
          untracked: gitStatus.untracked,
          spaces,
          distTags,
        }

        if (options.json) {
          console.log(JSON.stringify(status, null, 2))
        } else {
          formatStatusText(status)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
