/**
 * Repo status command - Show registry status.
 *
 * WHY: Provides visibility into the registry state, including
 * available spaces, tags, and any uncommitted changes.
 */

import { readdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { getStatus } from '@agent-spaces/git'
import { PathResolver, getAspHome } from '@agent-spaces/store'

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

        // Check if repo exists
        const repoFile = Bun.file(`${paths.repo}/.git/HEAD`)
        if (!(await repoFile.exists())) {
          console.error(chalk.red('No registry found'))
          console.error(chalk.gray(`Expected at: ${paths.repo}`))
          console.error(chalk.gray('Run "asp repo init" to create one'))
          process.exit(1)
        }

        // Get git status
        const gitStatus = await getStatus({ cwd: paths.repo })

        // List spaces
        let spaces: string[] = []
        try {
          const spacesDir = `${paths.repo}/spaces`
          const entries = await readdir(spacesDir, { withFileTypes: true })
          spaces = entries.filter((e) => e.isDirectory()).map((e) => e.name)
        } catch {
          // spaces dir may not exist
        }

        // Load dist-tags
        let distTags: Record<string, Record<string, string>> = {}
        try {
          const distTagsPath = `${paths.repo}/registry/dist-tags.json`
          const content = await Bun.file(distTagsPath).text()
          distTags = JSON.parse(content)
        } catch {
          // dist-tags.json may not exist
        }

        const output = {
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
          console.log(JSON.stringify(output, null, 2))
        } else {
          console.log(chalk.blue('Registry Status'))
          console.log('')
          console.log(`  Path: ${output.repoPath}`)
          console.log(`  Branch: ${output.branch}`)
          console.log(`  Status: ${output.clean ? chalk.green('clean') : chalk.yellow('modified')}`)

          if (!output.clean) {
            if (output.staged.length > 0) {
              console.log('')
              console.log(chalk.green('  Staged:'))
              for (const file of output.staged) {
                console.log(`    ${file}`)
              }
            }
            if (output.modified.length > 0) {
              console.log('')
              console.log(chalk.yellow('  Modified:'))
              for (const file of output.modified) {
                console.log(`    ${file}`)
              }
            }
            if (output.untracked.length > 0) {
              console.log('')
              console.log(chalk.gray('  Untracked:'))
              for (const file of output.untracked) {
                console.log(`    ${file}`)
              }
            }
          }

          console.log('')
          console.log(chalk.blue('Spaces'))
          if (spaces.length === 0) {
            console.log(chalk.gray('  No spaces found'))
          } else {
            for (const space of spaces) {
              const tags = distTags[space] ?? {}
              const tagList = Object.entries(tags)
                .map(([tag, version]) => `${tag}=${version}`)
                .join(', ')
              console.log(`  ${space}${tagList ? ` (${chalk.gray(tagList)})` : ''}`)
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
