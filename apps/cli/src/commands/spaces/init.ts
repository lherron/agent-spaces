/**
 * Spaces init command - Create a new space in the shared spaces root.
 *
 * WHY: Provides a quick way to scaffold a new space without
 * needing to run Claude or the manager space.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { spacesDirExists, validateSpaceId, writeSpaceScaffold } from './scaffold.js'

interface InitOptions {
  description?: string | undefined
  version?: string | undefined
  aspHome?: string | undefined
  registry?: string | undefined
}

/**
 * Register the spaces init command.
 */
export function registerSpacesInitCommand(parent: Command): void {
  parent
    .command('init')
    .description('Create a new space in the shared spaces root')
    .argument('<spaceId>', 'Space ID (kebab-case, e.g., my-awesome-space)')
    .option('-d, --description <text>', 'Space description')
    .option('-v, --version <version>', 'Initial version (default: 0.1.0)')
    .option('--registry <path>', 'Shared spaces root override (default: agents root)')
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
        const { registryPath } = resolvePaths(options)
        const spaceDir = `${registryPath}/spaces/${spaceId}`

        if (!(await spacesDirExists(registryPath))) {
          console.error(chalk.red(`Error: No shared spaces dir at ${registryPath}/spaces`))
          console.error(chalk.gray('Run "asp repo init" to create it'))
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

        await writeSpaceScaffold(registryPath, spaceId, { ...options, withExample: true })

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
        console.log(`  5. Compose it: ${chalk.cyan(`space:${spaceId}@dev`)}`)
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
