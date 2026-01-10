/**
 * Repo init command - Create/clone registry, install manager space.
 *
 * WHY: Sets up the registry repository for managing spaces.
 * Can either create a new empty registry or clone an existing one.
 */

import { mkdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { cloneRepo, initRepo } from '@agent-spaces/git'
import { PathResolver, ensureAspHome, getAspHome } from '@agent-spaces/store'

/**
 * Register the repo init command.
 */
export function registerRepoInitCommand(parent: Command): void {
  parent
    .command('init')
    .description('Initialize or clone a spaces registry')
    .option('--clone <url>', 'Clone from existing registry URL')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        // Ensure ASP_HOME exists
        await ensureAspHome()

        console.log(chalk.blue('Initializing registry...'))
        console.log(`  Location: ${paths.repo}`)

        // Check if repo already exists
        const repoFile = Bun.file(`${paths.repo}/.git/HEAD`)
        if (await repoFile.exists()) {
          console.log(chalk.yellow('Registry already exists'))
          console.log(chalk.gray('Use git commands directly to manage it'))
          return
        }

        if (options.clone) {
          // Clone existing registry
          console.log(`  Cloning from: ${options.clone}`)
          await cloneRepo(options.clone, paths.repo)
          console.log(chalk.green('Registry cloned successfully'))
        } else {
          // Initialize new empty registry
          await mkdir(paths.repo, { recursive: true })
          await initRepo(paths.repo)

          // Create initial structure
          await mkdir(`${paths.repo}/spaces`, { recursive: true })
          await mkdir(`${paths.repo}/registry`, { recursive: true })

          // Create empty dist-tags.json
          await Bun.write(`${paths.repo}/registry/dist-tags.json`, JSON.stringify({}, null, 2))

          // Create README
          await Bun.write(
            `${paths.repo}/README.md`,
            `# Spaces Registry

This is an Agent Spaces registry. Add spaces under \`spaces/\`.

## Structure

\`\`\`
spaces/
  my-space/
    space.toml
    commands/
    skills/
    ...
registry/
  dist-tags.json
\`\`\`

## Publishing

Use \`asp repo publish <space-id> --tag vX.Y.Z\` to create a version tag.
`
          )

          console.log(chalk.green('Registry initialized successfully'))
          console.log('')
          console.log(chalk.gray('Next steps:'))
          console.log(chalk.gray('  1. Add spaces under spaces/'))
          console.log(chalk.gray('  2. Commit your changes'))
          console.log(chalk.gray('  3. Use "asp repo publish" to tag versions'))
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
