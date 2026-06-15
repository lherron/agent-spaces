/**
 * Repo new-space command - deterministic registry space scaffold generator.
 *
 * WHY: Agents need one blessed executable path for creating space structure,
 * not prose that each agent has to interpret independently.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { validateSpaceId, writeSpaceScaffold } from '../spaces/scaffold.js'
import { registryExists } from './registry-fs.js'

interface RepoNewSpaceOptions {
  description?: string | undefined
  version?: string | undefined
  aspHome?: string | undefined
}

/**
 * Register the repo new-space command.
 */
export function registerRepoNewSpaceCommand(parent: Command): void {
  parent
    .command('new-space')
    .description('Create a new space scaffold in the registry')
    .argument('<spaceId>', 'Space ID (kebab-case, e.g., my-awesome-space)')
    .option('-d, --description <text>', 'Space description')
    .option('-v, --version <version>', 'Initial version (default: 0.1.0)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options: RepoNewSpaceOptions) => {
      try {
        const validationError = validateSpaceId(spaceId)
        if (validationError) {
          console.error(chalk.red(`Error: ${validationError}`))
          process.exit(1)
        }

        const { paths } = resolvePaths(options)
        const spaceDir = `${paths.repo}/spaces/${spaceId}`

        const repoExists = await registryExists(paths.repo)
        if (!repoExists) {
          console.error(chalk.red('Error: Registry not initialized'))
          console.error(chalk.gray('Run "asp repo init" first to create the registry'))
          process.exit(1)
        }

        const spaceExists = await Bun.file(`${spaceDir}/space.toml`).exists()
        if (spaceExists) {
          console.error(chalk.red(`Error: Space "${spaceId}" already exists`))
          console.error(chalk.gray(`Location: ${spaceDir}`))
          process.exit(1)
        }

        console.log(chalk.blue(`Creating space "${spaceId}"...`))

        await writeSpaceScaffold(paths.repo, spaceId, { ...options, withExample: false })

        console.log(chalk.green(`Space "${spaceId}" created successfully`))
        console.log('')
        console.log(chalk.gray('Location:'))
        console.log(`  ${spaceDir}`)
        console.log('')
        console.log(chalk.gray('Next steps:'))
        console.log(`  1. Add commands in ${chalk.cyan('commands/')}`)
        console.log(`  2. Add skills in ${chalk.cyan('skills/')}`)
        console.log('  3. Add agents, hooks, or MCP config as needed')
        console.log(`  4. Test locally: ${chalk.cyan(`asp run ${spaceDir}`)}`)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
