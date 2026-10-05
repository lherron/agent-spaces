/**
 * Repo init command - bootstrap a shared spaces root with the manager space.
 *
 * WHY: The published CLI ships dist/ only, so the embedded manager space is
 * the one way to put agent-spaces-manager onto a fresh shared spaces root.
 * The root is a plain directory: no git init, tags or dist-tags (T-04144).
 */

import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { MANAGER_SPACE_ID, getManagerSpaceFiles } from './manager-space-content'

interface RepoInitOptions {
  aspHome?: string | undefined
  registry?: string | undefined
  manager: boolean
}

/**
 * Install the manager space into the shared spaces root.
 */
async function installManagerSpace(spaceDir: string): Promise<void> {
  for (const file of getManagerSpaceFiles()) {
    const fullPath = `${spaceDir}/${file.path}`
    await mkdir(dirname(fullPath), { recursive: true })
    await Bun.write(fullPath, file.content)
  }
}

/**
 * Register the repo init command.
 */
export function registerRepoInitCommand(parent: Command): void {
  parent
    .command('init')
    .description('Create the shared spaces dir and install the manager space')
    .option('--registry <path>', 'Shared spaces root override (default: agents root)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--no-manager', 'Skip installing the manager space')
    .action(async (options: RepoInitOptions) => {
      try {
        const { registryPath } = resolvePaths(options)
        const spacesDir = `${registryPath}/spaces`
        await mkdir(spacesDir, { recursive: true })
        console.log(chalk.blue(`Shared spaces dir: ${spacesDir}`))

        if (options.manager === false) {
          return
        }

        const spaceDir = `${spacesDir}/${MANAGER_SPACE_ID}`
        if (await Bun.file(`${spaceDir}/space.toml`).exists()) {
          console.log(chalk.gray(`Manager space already present: ${spaceDir}`))
          return
        }

        await installManagerSpace(spaceDir)
        console.log(chalk.green(`Installed manager space: ${spaceDir}`))
        console.log('')
        console.log(chalk.gray('Next step:'))
        console.log(chalk.cyan(`  asp run space:${MANAGER_SPACE_ID}@dev`))
      } catch (error) {
        exitWithAspError(error)
      }
    })
}
