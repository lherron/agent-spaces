/**
 * Init command - Create a new asp-targets.toml project file.
 *
 * WHY: Provides a quick way to initialize a project with a default
 * target so users can start adding spaces immediately.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { TARGETS_FILENAME } from 'spaces-core'

import { handleCliError } from '../helpers.js'

interface InitOptions {
  target?: string | undefined
  force?: boolean | undefined
}

/**
 * Generate a minimal asp-targets.toml content.
 */
function generateTargetsToml(targetName: string): string {
  return `schema = 1

[targets.${targetName}]
description = "Default target"
compose = ["space:defaults@stable"]
`
}

/**
 * Register the init command.
 */
export function registerInitCommand(program: Command): void {
  program
    .command('init')
    .description('Create a new asp-targets.toml project file')
    .option('-t, --target <name>', 'Name of the default target', 'dev')
    .option('-f, --force', 'Overwrite existing asp-targets.toml')
    .action(async (options: InitOptions) => {
      try {
        const targetName = options.target ?? 'dev'
        const targetsPath = `${process.cwd()}/${TARGETS_FILENAME}`

        // Check if file already exists
        const exists = await Bun.file(targetsPath).exists()
        if (exists && !options.force) {
          console.error(chalk.red(`Error: ${TARGETS_FILENAME} already exists`))
          console.error(chalk.gray('Use --force to overwrite'))
          process.exit(1)
        }

        // Generate and write the file
        const content = generateTargetsToml(targetName)
        await Bun.write(targetsPath, content)

        console.log(chalk.green(`Created ${TARGETS_FILENAME}`))
        console.log('')
        console.log(chalk.gray('Next steps:'))
        console.log(
          `  1. Add spaces: ${chalk.cyan(`asp add space:my-space@stable --target ${targetName}`)}`
        )
        console.log(`  2. Install:    ${chalk.cyan('asp install')}`)
        console.log(`  3. Run:        ${chalk.cyan(`asp run --target ${targetName}`)}`)
      } catch (error) {
        handleCliError(error)
      }
    })
}
