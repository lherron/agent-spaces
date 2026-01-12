/**
 * Spaces list command - List spaces in the registry.
 *
 * WHY: Provides visibility into available spaces without
 * needing to navigate the filesystem.
 */

import { readdir } from 'node:fs/promises'
import chalk from 'chalk'
import type { Command } from 'commander'

import { readSpaceToml } from '@agent-spaces/core'
import { PathResolver, getAspHome } from '@agent-spaces/store'

import { handleCliError } from '../../helpers.js'

interface SpaceInfo {
  id: string
  version: string | undefined
  description: string | undefined
  tags: Record<string, string>
  path: string
}

interface ListOutput {
  repoPath: string
  spaces: SpaceInfo[]
}

/**
 * Check if registry exists.
 */
async function ensureRegistryExists(repoPath: string): Promise<boolean> {
  const repoFile = Bun.file(`${repoPath}/.git/HEAD`)
  return repoFile.exists()
}

/**
 * Load dist-tags from registry.
 */
async function loadDistTags(repoPath: string): Promise<Record<string, Record<string, string>>> {
  try {
    const distTagsPath = `${repoPath}/registry/dist-tags.json`
    const content = await Bun.file(distTagsPath).text()
    return JSON.parse(content)
  } catch {
    return {}
  }
}

/**
 * Get info for a single space.
 */
async function getSpaceInfo(
  repoPath: string,
  spaceId: string,
  distTags: Record<string, Record<string, string>>
): Promise<SpaceInfo | null> {
  const spacePath = `${repoPath}/spaces/${spaceId}`
  const spaceTomlPath = `${spacePath}/space.toml`

  try {
    const manifest = await readSpaceToml(spaceTomlPath)
    return {
      id: manifest.id,
      version: manifest.version,
      description: manifest.description,
      tags: distTags[spaceId] ?? {},
      path: spacePath,
    }
  } catch {
    // Space directory exists but no valid space.toml
    return null
  }
}

/**
 * List all spaces in registry.
 */
async function listSpaces(repoPath: string): Promise<SpaceInfo[]> {
  const distTags = await loadDistTags(repoPath)
  const spacesDir = `${repoPath}/spaces`

  try {
    const entries = await readdir(spacesDir, { withFileTypes: true })
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)

    const spaces: SpaceInfo[] = []
    for (const dir of dirs) {
      const info = await getSpaceInfo(repoPath, dir, distTags)
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

    const tagEntries = Object.entries(space.tags)
    if (tagEntries.length > 0) {
      const tagList = tagEntries.map(([tag, ver]) => `${tag}=${ver}`).join(', ')
      console.log(`    Tags: ${chalk.yellow(tagList)}`)
    }

    console.log('')
  }

  console.log(chalk.gray(`Registry: ${output.repoPath}`))
}

/**
 * Register the spaces list command.
 */
export function registerSpacesListCommand(parent: Command): void {
  parent
    .command('list')
    .description('List spaces in the registry')
    .option('--json', 'Output as JSON')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        const exists = await ensureRegistryExists(paths.repo)
        if (!exists) {
          console.error(chalk.red('Error: Registry not initialized'))
          console.error(chalk.gray('Run "asp repo init" first to create the registry'))
          process.exit(1)
        }

        const spaces = await listSpaces(paths.repo)

        const output: ListOutput = {
          repoPath: paths.repo,
          spaces,
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatListText(output)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
