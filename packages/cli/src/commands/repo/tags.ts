/**
 * Repo tags command - List tags for a space.
 *
 * WHY: Shows available versions for a space, helping users
 * understand what versions are available to reference.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { listTags } from '@agent-spaces/git'
import { PathResolver, getAspHome } from '@agent-spaces/store'

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
    .action(async (spaceId: string, options) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        // Check if repo exists
        const repoFile = Bun.file(`${paths.repo}/.git/HEAD`)
        if (!(await repoFile.exists())) {
          console.error(chalk.red('No registry found'))
          console.error(chalk.gray('Run "asp repo init" first'))
          process.exit(1)
        }

        // List tags matching pattern
        const pattern = `space/${spaceId}/v*`
        const tags = await listTags(pattern, { cwd: paths.repo })

        // Parse version info from tags
        const versions = tags
          .map((tag) => {
            const match = tag.match(/^space\/[^/]+\/(.+)$/)
            return match ? match[1] : null
          })
          .filter((v): v is string => v !== null)
          .sort((a, b) => {
            // Sort by semver (descending)
            const parseVersion = (v: string): [number, number, number] => {
              const match = v.match(/^v(\d+)\.(\d+)\.(\d+)/)
              if (!match || !match[1] || !match[2] || !match[3]) return [0, 0, 0]
              return [
                Number.parseInt(match[1], 10),
                Number.parseInt(match[2], 10),
                Number.parseInt(match[3], 10),
              ]
            }
            const aVer = parseVersion(a)
            const bVer = parseVersion(b)
            if (aVer[0] !== bVer[0]) return bVer[0] - aVer[0]
            if (aVer[1] !== bVer[1]) return bVer[1] - aVer[1]
            return bVer[2] - aVer[2]
          })

        // Load dist-tags
        let distTags: Record<string, string> = {}
        try {
          const distTagsPath = `${paths.repo}/registry/dist-tags.json`
          const content = await Bun.file(distTagsPath).text()
          const allDistTags = JSON.parse(content)
          distTags = allDistTags[spaceId] ?? {}
        } catch {
          // dist-tags.json may not exist
        }

        const output = {
          spaceId,
          versions,
          distTags,
        }

        if (options.json) {
          console.log(JSON.stringify(output, null, 2))
        } else {
          console.log(chalk.blue(`Tags for ${spaceId}`))
          console.log('')

          if (versions.length === 0) {
            console.log(chalk.gray('  No versions found'))
          } else {
            // Show dist-tags first
            if (Object.keys(distTags).length > 0) {
              console.log('  Dist tags:')
              for (const [tag, version] of Object.entries(distTags)) {
                console.log(`    ${chalk.cyan(tag)} -> ${version}`)
              }
              console.log('')
            }

            console.log('  Versions:')
            for (const version of versions) {
              // Check if this version has any dist-tags
              const tags = Object.entries(distTags)
                .filter(([, v]) => v === version)
                .map(([t]) => t)

              if (tags.length > 0) {
                console.log(`    ${version} ${chalk.gray(`(${tags.join(', ')})`)}`)
              } else {
                console.log(`    ${version}`)
              }
            }
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
