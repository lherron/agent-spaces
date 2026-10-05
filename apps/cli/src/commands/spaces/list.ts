/**
 * Spaces list command - List spaces in the shared spaces root.
 *
 * WHY: Provides visibility into available spaces without
 * needing to navigate the filesystem.
 */

import { readdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { readSpaceToml } from 'spaces-config'

import { exitWithAspError, resolvePaths } from '../../helpers.js'
import { spacesDirExists } from './scaffold.js'

interface SpaceInfo {
  id: string
  version: string | undefined
  description: string | undefined
  path: string
}

interface ListOutput {
  spacesRoot: string
  spaces: SpaceInfo[]
}

/**
 * Get info for a single space.
 */
async function getSpaceInfo(root: string, spaceId: string): Promise<SpaceInfo | null> {
  const spacePath = `${root}/spaces/${spaceId}`
  const spaceTomlPath = `${spacePath}/space.toml`

  try {
    const manifest = await readSpaceToml(spaceTomlPath)
    return {
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      path: spacePath,
    }
  } catch {
    // Space directory exists but no valid space.toml
    return null
  }
}

/**
 * List all spaces in the shared spaces root.
 */
async function listSpaces(root: string): Promise<SpaceInfo[]> {
  const spacesDir = `${root}/spaces`

  try {
    const entries = await readdir(spacesDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

    const spaces: SpaceInfo[] = []
    for (const dir of dirs) {
      const info = await getSpaceInfo(root, dir)
      if (info) {
        spaces.push(info)
      }
    }

    return spaces.sort((a, b) => a.id.localeCompare(b.id))
  } catch {
    return []
  }
}

/**
 * Format spaces list for text output.
 */
function formatListText(output: ListOutput): void {
  console.log(chalk.blue('Spaces'))
  console.log('')

  if (output.spaces.length === 0) {
    console.log(chalk.gray('  No spaces found'))
    console.log('')
    console.log(chalk.gray('Create one with: asp spaces init <space-id>'))
    return
  }

  for (const space of output.spaces) {
    const version = space.version ? chalk.cyan(`v${space.version}`) : chalk.gray('(no version)')
    console.log(`  ${chalk.bold(space.id)} ${version}`)

    if (space.description) {
      console.log(`    ${chalk.gray(space.description)}`)
    }

    console.log('')
  }

  console.log(chalk.gray(`Shared spaces root: ${output.spacesRoot}`))
}

/**
 * Register the spaces list command.
 */
export function registerSpacesListCommand(parent: Command): void {
  parent
    .command('list')
    .description('List spaces in the shared spaces root')
    .option('--json', 'Output as JSON')
    .option('--registry <path>', 'Shared spaces root override (default: agents root)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      try {
        const { registryPath } = resolvePaths(options)

        if (!(await spacesDirExists(registryPath))) {
          console.error(chalk.red(`Error: No shared spaces dir at ${registryPath}/spaces`))
          console.error(chalk.gray('Run "asp repo init" to create it'))
          process.exit(1)
        }

        const output: ListOutput = {
          spacesRoot: registryPath,
          spaces: await listSpaces(registryPath),
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatListText(output)
        }
      } catch (error) {
        exitWithAspError(error, options)
      }
    })
}
