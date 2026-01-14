/**
 * Repo tags command - List tags for a space.
 *
 * WHY: Shows available versions for a space, helping users
 * understand what versions are available to reference.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { listTags } from 'spaces-git'
import { PathResolver, getAspHome } from 'spaces-store'

import { handleCliError } from '../../helpers.js'

interface RepoTagsOptions {
  json?: boolean | undefined
  aspHome?: string | undefined
}

interface TagsOutput {
  spaceId: string
  versions: string[]
  distTags: Record<string, string>
}

/**
 * Parse version from tag name.
 */
function parseVersionFromTag(tag: string): string | null {
  const match = tag.match(/^space\/[^/]+\/(.+)$/)
  return match?.[1] ?? null
}

/**
 * Parse semver components from version string.
 */
function parseSemver(v: string): [number, number, number] {
  const match = v.match(/^v(\d+)\.(\d+)\.(\d+)/)
  if (!match || !match[1] || !match[2] || !match[3]) return [0, 0, 0]
  return [
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    Number.parseInt(match[3], 10),
  ]
}

/**
 * Sort versions by semver descending.
 */
function sortVersionsDescending(versions: string[]): string[] {
  return versions.sort((a, b) => {
    const aVer = parseSemver(a)
    const bVer = parseSemver(b)
    if (aVer[0] !== bVer[0]) return bVer[0] - aVer[0]
    if (aVer[1] !== bVer[1]) return bVer[1] - aVer[1]
    return bVer[2] - aVer[2]
  })
}

/**
 * Load dist-tags for a space.
 */
async function loadDistTags(repoPath: string, spaceId: string): Promise<Record<string, string>> {
  try {
    const content = await Bun.file(`${repoPath}/registry/dist-tags.json`).text()
    const allDistTags = JSON.parse(content)
    return allDistTags[spaceId] ?? {}
  } catch {
    return {}
  }
}

/**
 * Format tags output as text.
 */
function formatTagsText(output: TagsOutput): void {
  console.log(chalk.blue(`Tags for ${output.spaceId}`))
  console.log('')

  if (output.versions.length === 0) {
    console.log(chalk.gray('  No versions found'))
    return
  }

  if (Object.keys(output.distTags).length > 0) {
    console.log('  Dist tags:')
    for (const [tag, version] of Object.entries(output.distTags)) {
      console.log(`    ${chalk.cyan(tag)} -> ${version}`)
    }
    console.log('')
  }

  console.log('  Versions:')
  for (const version of output.versions) {
    const matchingTags = Object.entries(output.distTags)
      .filter(([, v]) => v === version)
      .map(([t]) => t)

    if (matchingTags.length > 0) {
      console.log(`    ${version} ${chalk.gray(`(${matchingTags.join(', ')})`)}`)
    } else {
      console.log(`    ${version}`)
    }
  }
}

/**
 * Register the repo tags command.
 */
export function registerRepoTagsCommand(parent: Command): void {
  parent
    .command('tags')
    .description('List version tags for a space')
    .argument('<spaceId>', 'Space ID to list tags for')
    .option('--json', 'Output as JSON')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options: RepoTagsOptions) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        if (!(await Bun.file(`${paths.repo}/.git/HEAD`).exists())) {
          throw new Error('No registry found. Run "asp repo init" first.')
        }

        const tags = await listTags(`space/${spaceId}/v*`, { cwd: paths.repo })
        const versions = sortVersionsDescending(
          tags.map(parseVersionFromTag).filter((v): v is string => v !== null)
        )
        const distTags = await loadDistTags(paths.repo, spaceId)

        const output: TagsOutput = { spaceId, versions, distTags }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          formatTagsText(output)
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
