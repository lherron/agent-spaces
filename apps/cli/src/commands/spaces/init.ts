/**
 * Spaces init command - Create a new space in the registry.
 *
 * WHY: Provides a quick way to scaffold a new space without
 * needing to run Claude or the manager space.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { registryExists } from '../repo/registry-fs.js'
import { validateSpaceId, writeSpaceScaffold } from './scaffold.js'

interface InitOptions {
  description?: string | undefined
  version?: string | undefined
  aspHome?: string | undefined
}

/**
 * Register the spaces init command.
 */
export function registerSpacesInitCommand(parent: Command): void {
  parent
    .command('init')
    .description('Create a new space in the registry')
    .argument('<spaceId>', 'Space ID (kebab-case, e.g., my-awesome-space)')
    .option('-d, --description <text>', 'Space description')
    .option('-v, --version <version>', 'Initial version (default: 0.1.0)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options: InitOptions) => {
      try {
        // Validate space ID
        const validationError = validateSpaceId(spaceId)
        if (validationError) {
          console.error(chalk.red(`Error: ${validationError}`))
          process.exit(1)
        }

        // Get paths
        const { paths } = resolvePaths(options)
        const spaceDir = `${paths.repo}/spaces/${spaceId}`

        // Check if registry exists
        const repoExists = await registryExists(paths.repo)
        if (!repoExists) {
          console.error(chalk.red('Error: Registry not initialized'))
          console.error(chalk.gray('Run "asp repo init" first to create the registry'))
          process.exit(1)
        }

        // Check if space already exists
        const spaceExists = await Bun.file(`${spaceDir}/space.toml`).exists()
        if (spaceExists) {
          console.error(chalk.red(`Error: Space "${spaceId}" already exists`))
          console.error(chalk.gray(`Location: ${spaceDir}`))
          process.exit(1)
        }

        console.log(chalk.blue(`Creating space "${spaceId}"...`))

        await writeSpaceScaffold(paths.repo, spaceId, { ...options, withExample: true })

        console.log(chalk.green(`Space "${spaceId}" created successfully`))
        console.log('')
        console.log(chalk.gray('Location:'))
        console.log(`  ${spaceDir}`)
        console.log('')
        console.log(chalk.gray('Next steps:'))
        console.log(`  1. Edit ${chalk.cyan('space.toml')} to configure your space`)
        console.log(`  2. Add commands in ${chalk.cyan('commands/')}`)
        console.log(`  3. Add skills in ${chalk.cyan('skills/')}`)
        console.log(`  4. Test locally: ${chalk.cyan(`asp run ${spaceDir}`)}`)
        console.log(`  5. Publish: ${chalk.cyan(`asp repo publish ${spaceId} --tag v0.1.0`)}`)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
