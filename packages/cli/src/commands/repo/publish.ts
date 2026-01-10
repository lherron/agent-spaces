/**
 * Repo publish command - Create git tag, update dist-tags.json.
 *
 * WHY: Creates immutable version tags for spaces and updates
 * channel pointers (stable, latest, etc.) for easy reference.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { atomicWriteJson } from '@agent-spaces/core'
import { createAnnotatedTag } from '@agent-spaces/git'
import { PathResolver, getAspHome } from '@agent-spaces/store'

/**
 * Register the repo publish command.
 */
export function registerRepoPublishCommand(parent: Command): void {
  parent
    .command('publish')
    .description('Create version tag and update dist-tags')
    .argument('<spaceId>', 'Space ID to publish')
    .requiredOption('--tag <version>', 'Version tag (e.g., v1.0.0)')
    .option('--dist-tag <name>', 'Also update dist-tag (e.g., stable, latest)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (spaceId: string, options) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        // Validate version tag format
        const version = options.tag
        if (!version.match(/^v\d+\.\d+\.\d+(-[\w.]+)?$/)) {
          console.error(chalk.red('Error: Invalid version tag format'))
          console.error(chalk.gray('Expected format: vX.Y.Z or vX.Y.Z-prerelease'))
          process.exit(1)
        }

        // Check if repo exists
        const repoFile = Bun.file(`${paths.repo}/.git/HEAD`)
        if (!(await repoFile.exists())) {
          console.error(chalk.red('No registry found'))
          console.error(chalk.gray('Run "asp repo init" first'))
          process.exit(1)
        }

        // Check if space exists
        const spaceToml = Bun.file(`${paths.repo}/spaces/${spaceId}/space.toml`)
        if (!(await spaceToml.exists())) {
          console.error(chalk.red(`Space "${spaceId}" not found`))
          console.error(chalk.gray(`Expected at: spaces/${spaceId}/space.toml`))
          process.exit(1)
        }

        // Create git tag
        const tagName = `space/${spaceId}/${version}`
        console.log(chalk.blue(`Creating tag: ${tagName}`))

        await createAnnotatedTag(tagName, `Release ${spaceId} ${version}`, undefined, {
          cwd: paths.repo,
        })

        console.log(chalk.green(`Tag created: ${tagName}`))

        // Update dist-tags if requested
        if (options.distTag) {
          const distTagsPath = `${paths.repo}/registry/dist-tags.json`
          let distTags: Record<string, Record<string, string>> = {}

          try {
            const content = await Bun.file(distTagsPath).text()
            distTags = JSON.parse(content)
          } catch {
            // File may not exist
          }

          // Update the dist-tag
          if (!distTags[spaceId]) {
            distTags[spaceId] = {}
          }
          distTags[spaceId][options.distTag] = version

          // Write atomically
          await atomicWriteJson(distTagsPath, distTags)

          console.log(chalk.green(`Dist-tag updated: ${spaceId}@${options.distTag} -> ${version}`))
          console.log('')
          console.log(chalk.gray('Remember to commit and push dist-tags.json'))
        }

        console.log('')
        console.log(chalk.gray('To push the tag:'))
        console.log(chalk.gray(`  cd ${paths.repo} && git push origin ${tagName}`))
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
