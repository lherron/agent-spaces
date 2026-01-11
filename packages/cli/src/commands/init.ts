/**
 * Init command - Create a new space in the registry.
 *
 * WHY: Provides a quick way to scaffold a new space without
 * needing to run Claude or the manager space.
 */

import { mkdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { PathResolver, getAspHome } from '@agent-spaces/store'

import { handleCliError } from '../helpers.js'

interface InitOptions {
  description?: string | undefined
  version?: string | undefined
  aspHome?: string | undefined
}

const SPACE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/**
 * Validate space ID format.
 */
function validateSpaceId(id: string): string | null {
  if (!id) {
    return 'Space ID is required'
  }
  if (id.length > 64) {
    return 'Space ID must be 64 characters or less'
  }
  if (!SPACE_ID_PATTERN.test(id)) {
    return 'Space ID must be kebab-case (lowercase letters, numbers, hyphens) and start with a letter'
  }
  return null
}

/**
 * Generate space.toml content.
 */
function generateSpaceToml(id: string, options: InitOptions): string {
  const lines: string[] = ['schema = 1', `id = "${id}"`]

  if (options.version) {
    lines.push(`version = "${options.version}"`)
  } else {
    lines.push('version = "0.1.0"')
  }

  if (options.description) {
    lines.push(`description = "${options.description}"`)
  }

  lines.push('')
  lines.push('[plugin]')
  lines.push(`name = "${id}"`)
  lines.push('')

  return lines.join('\n')
}

/**
 * Generate example command file.
 */
function generateExampleCommand(id: string): string {
  return `# Example Command

This is an example command for the ${id} space.

## Usage

Describe how to use this command.

## Execution Steps

1. First step
2. Second step
3. Final step
`
}

/**
 * Register the init command.
 */
export function registerInitCommand(program: Command): void {
  program
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
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })
        const spaceDir = `${paths.repo}/spaces/${spaceId}`

        // Check if registry exists
        const repoExists = await Bun.file(`${paths.repo}/.git/HEAD`).exists()
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

        // Create directory structure
        await mkdir(spaceDir, { recursive: true })
        await mkdir(`${spaceDir}/commands`, { recursive: true })
        await mkdir(`${spaceDir}/skills`, { recursive: true })
        await mkdir(`${spaceDir}/agents`, { recursive: true })

        // Generate and write space.toml
        const spaceToml = generateSpaceToml(spaceId, options)
        await Bun.write(`${spaceDir}/space.toml`, spaceToml)

        // Write example command
        const exampleCommand = generateExampleCommand(spaceId)
        await Bun.write(`${spaceDir}/commands/example.md`, exampleCommand)

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
        handleCliError(error)
      }
    })
}
