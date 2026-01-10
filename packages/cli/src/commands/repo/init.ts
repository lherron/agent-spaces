/**
 * Repo init command - Create/clone registry, install manager space.
 *
 * WHY: Sets up the registry repository for managing spaces.
 * Can either create a new empty registry or clone an existing one.
 * Per spec, installs the built-in agent-spaces-manager space.
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import { add, cloneRepo, commit, createTag, initRepo } from '@agent-spaces/git'
import { PathResolver, ensureAspHome, getAspHome } from '@agent-spaces/store'
import {
  MANAGER_SPACE_ID,
  MANAGER_SPACE_VERSION,
  getManagerSpaceFiles,
} from './manager-space-content'

/**
 * Register the repo init command.
 */
export function registerRepoInitCommand(parent: Command): void {
  parent
    .command('init')
    .description('Initialize or clone a spaces registry')
    .option('--clone <url>', 'Clone from existing registry URL')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--no-manager', 'Skip installing the manager space (for testing)')
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

          // Install manager space unless --no-manager is passed
          const installManager = options.manager !== false
          let distTags: Record<string, Record<string, string>> = {}

          if (installManager) {
            console.log(chalk.blue('Installing manager space...'))
            await installManagerSpace(paths.repo)
            distTags = {
              [MANAGER_SPACE_ID]: {
                stable: `v${MANAGER_SPACE_VERSION}`,
                latest: `v${MANAGER_SPACE_VERSION}`,
              },
            }
          }

          // Create dist-tags.json
          await Bun.write(
            `${paths.repo}/registry/dist-tags.json`,
            JSON.stringify(distTags, null, 2)
          )

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

## Manager Space

The \`agent-spaces-manager\` space is pre-installed to help you create and manage spaces.
Run \`asp run space:agent-spaces-manager@stable\` to get started.
`
          )

          // Create initial commit
          await add(['.'], { cwd: paths.repo })
          await commit('chore: Initialize registry with manager space', { cwd: paths.repo })

          // Create initial tag for manager space
          if (installManager) {
            const tagName = `space/${MANAGER_SPACE_ID}/v${MANAGER_SPACE_VERSION}`
            await createTag(tagName, undefined, { cwd: paths.repo })
            console.log(chalk.green(`  Created tag: ${tagName}`))
          }

          console.log(chalk.green('Registry initialized successfully'))
          console.log('')
          console.log(chalk.gray('Next steps:'))
          if (installManager) {
            console.log(chalk.cyan('  Run: asp run space:agent-spaces-manager@stable'))
            console.log(
              chalk.gray('  The manager space will guide you through creating your first space.')
            )
          } else {
            console.log(chalk.gray('  1. Add spaces under spaces/'))
            console.log(chalk.gray('  2. Commit your changes'))
            console.log(chalk.gray('  3. Use "asp repo publish" to tag versions'))
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

/**
 * Install the manager space into the registry.
 * Creates all files from the embedded content.
 */
async function installManagerSpace(repoPath: string): Promise<void> {
  const spaceDir = `${repoPath}/spaces/${MANAGER_SPACE_ID}`
  const files = getManagerSpaceFiles()

  for (const file of files) {
    const fullPath = `${spaceDir}/${file.path}`
    // Ensure parent directory exists
    await mkdir(dirname(fullPath), { recursive: true })
    await Bun.write(fullPath, file.content)
  }
}
