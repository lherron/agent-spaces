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

import { add, cloneRepo, commit, createTag, initRepo } from 'spaces-git'
import { PathResolver, ensureAspHome, getAspHome } from 'spaces-store'

import { handleCliError } from '../../helpers.js'
import {
  MANAGER_SPACE_ID,
  MANAGER_SPACE_VERSION,
  getManagerSpaceFiles,
} from './manager-space-content'

interface RepoInitOptions {
  clone?: string | undefined
  aspHome?: string | undefined
  manager: boolean
}

const README_TEMPLATE = `# Spaces Registry

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

/**
 * Install the manager space into the registry.
 */
async function installManagerSpace(repoPath: string): Promise<void> {
  const spaceDir = `${repoPath}/spaces/${MANAGER_SPACE_ID}`
  for (const file of getManagerSpaceFiles()) {
    const fullPath = `${spaceDir}/${file.path}`
    await mkdir(dirname(fullPath), { recursive: true })
    await Bun.write(fullPath, file.content)
  }
}

/**
 * Create initial registry structure and files.
 */
async function createInitialRegistry(repoPath: string, installManager: boolean): Promise<void> {
  await mkdir(repoPath, { recursive: true })
  await initRepo(repoPath)
  await mkdir(`${repoPath}/spaces`, { recursive: true })
  await mkdir(`${repoPath}/registry`, { recursive: true })

  let distTags: Record<string, Record<string, string>> = {}
  if (installManager) {
    console.log(chalk.blue('Installing manager space...'))
    await installManagerSpace(repoPath)
    distTags = {
      [MANAGER_SPACE_ID]: {
        stable: `v${MANAGER_SPACE_VERSION}`,
        latest: `v${MANAGER_SPACE_VERSION}`,
      },
    }
  }

  await Bun.write(`${repoPath}/registry/dist-tags.json`, JSON.stringify(distTags, null, 2))
  await Bun.write(`${repoPath}/README.md`, README_TEMPLATE)
  await add(['.'], { cwd: repoPath })
  await commit('chore: Initialize registry with manager space', { cwd: repoPath })

  if (installManager) {
    const tagName = `space/${MANAGER_SPACE_ID}/v${MANAGER_SPACE_VERSION}`
    await createTag(tagName, undefined, { cwd: repoPath })
    console.log(chalk.green(`  Created tag: ${tagName}`))
  }
}

/**
 * Print next steps after initialization.
 */
function printNextSteps(installManager: boolean): void {
  console.log(chalk.green('Registry initialized successfully'))
  console.log('')
  console.log(chalk.gray('Next steps:'))
  if (installManager) {
    console.log(chalk.cyan('  Run: asp run space:agent-spaces-manager@stable'))
    console.log(chalk.gray('  The manager space will guide you through creating your first space.'))
  } else {
    console.log(chalk.gray('  1. Add spaces under spaces/'))
    console.log(chalk.gray('  2. Commit your changes'))
    console.log(chalk.gray('  3. Use "asp repo publish" to tag versions'))
  }
}

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
    .action(async (options: RepoInitOptions) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })
        await ensureAspHome()

        console.log(chalk.blue('Initializing registry...'))
        console.log(`  Location: ${paths.repo}`)

        if (await Bun.file(`${paths.repo}/.git/HEAD`).exists()) {
          console.log(chalk.yellow('Registry already exists'))
          console.log(chalk.gray('Use git commands directly to manage it'))
          return
        }

        if (options.clone) {
          console.log(`  Cloning from: ${options.clone}`)
          await cloneRepo(options.clone, paths.repo)
          console.log(chalk.green('Registry cloned successfully'))
        } else {
          await createInitialRegistry(paths.repo, options.manager !== false)
          printNextSteps(options.manager !== false)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
