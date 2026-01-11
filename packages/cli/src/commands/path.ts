/**
 * Path command - Print the filesystem path to a space.
 *
 * WHY: Allows users to easily navigate to space directories
 * using cd $(asp path my-space).
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { PathResolver, getAspHome } from '@agent-spaces/store'

interface PathOptions {
  aspHome?: string | undefined
  registry?: string | undefined
}

/**
 * Register the path command.
 */
export function registerPathCommand(program: Command): void {
  program
    .command('path')
    .description('Print the filesystem path to a space')
    .argument('<spaceId>', 'Space ID')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--registry <path>', 'Registry path override')
    .action(async (spaceId: string, options: PathOptions) => {
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })
      const registryPath = options.registry ?? paths.repo
      const spaceDir = `${registryPath}/spaces/${spaceId}`

      // Check if space exists
      const spaceExists = await Bun.file(`${spaceDir}/space.toml`).exists()
      if (!spaceExists) {
        console.error(chalk.red(`Error: Space "${spaceId}" not found`))
        process.exit(1)
      }

      // Just print the path (no newline issues for shell usage)
      console.log(spaceDir)
    })
}
