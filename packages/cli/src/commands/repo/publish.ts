/**
 * Repo publish command - Create git tag, update dist-tags.json.
 *
 * WHY: Creates immutable version tags for spaces and updates
 * channel pointers (stable, latest, etc.) for easy reference.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { atomicWriteJson } from '@agent-spaces/core'
import { createAnnotatedTag, gitExecLines } from '@agent-spaces/git'
import { PathResolver, getAspHome } from '@agent-spaces/store'

import { handleCliError } from '../../helpers.js'

interface RepoPublishOptions {
  tag: string
  distTag?: string | undefined
  aspHome?: string | undefined
}

/**
 * Validate version tag format.
 */
function validateVersionTag(version: string): void {
  if (!version.match(/^v\d+\.\d+\.\d+(-[\w.]+)?$/)) {
    throw new Error('Invalid version tag format. Expected: vX.Y.Z or vX.Y.Z-prerelease')
  }
}

/**
 * Ensure registry exists.
 */
async function ensureRegistryExists(repoPath: string): Promise<void> {
  if (!(await Bun.file(`${repoPath}/.git/HEAD`).exists())) {
    throw new Error('No registry found. Run "asp repo init" first.')
  }
}

/**
 * Ensure space exists in registry.
 */
async function ensureSpaceExists(repoPath: string, spaceId: string): Promise<void> {
  if (!(await Bun.file(`${repoPath}/spaces/${spaceId}/space.toml`).exists())) {
    throw new Error(`Space "${spaceId}" not found. Expected at: spaces/${spaceId}/space.toml`)
  }
}

/**
 * Check for uncommitted changes in the space directory.
 */
async function checkUncommittedChanges(repoPath: string, spaceId: string): Promise<void> {
  const spacePath = `spaces/${spaceId}/`
  const lines = await gitExecLines(['status', '--porcelain', '--', spacePath], { cwd: repoPath })

  if (lines.length > 0) {
    const changes = lines.map((line) => `  ${line}`).join('\n')
    throw new Error(
      `Uncommitted changes in ${spacePath}:\n${changes}\n\nCommit or stash changes before publishing.`
    )
  }
}

/**
 * Update dist-tags.json with new tag.
 */
async function updateDistTags(
  repoPath: string,
  spaceId: string,
  distTag: string,
  version: string
): Promise<void> {
  const distTagsPath = `${repoPath}/registry/dist-tags.json`
  let distTags: Record<string, Record<string, string>> = {}

  try {
    distTags = JSON.parse(await Bun.file(distTagsPath).text())
  } catch {
    // File may not exist
  }

  if (!distTags[spaceId]) {
    distTags[spaceId] = {}
  }
  distTags[spaceId][distTag] = version
  await atomicWriteJson(distTagsPath, distTags)

  console.log(chalk.green(`Dist-tag updated: ${spaceId}@${distTag} -> ${version}`))
  console.log('')
  console.log(chalk.gray('Remember to commit and push dist-tags.json'))
}

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
    .action(async (spaceId: string, options: RepoPublishOptions) => {
      try {
        const aspHome = options.aspHome ?? getAspHome()
        const paths = new PathResolver({ aspHome })

        validateVersionTag(options.tag)
        await ensureRegistryExists(paths.repo)
        await ensureSpaceExists(paths.repo, spaceId)
        await checkUncommittedChanges(paths.repo, spaceId)

        const tagName = `space/${spaceId}/${options.tag}`
        console.log(chalk.blue(`Creating tag: ${tagName}`))
        await createAnnotatedTag(tagName, `Release ${spaceId} ${options.tag}`, undefined, {
          cwd: paths.repo,
        })
        console.log(chalk.green(`Tag created: ${tagName}`))

        // Update dist-tags: stable and latest by default, or custom if specified
        if (options.distTag) {
          await updateDistTags(paths.repo, spaceId, options.distTag, options.tag)
        } else {
          // Default: update both stable and latest
          await updateDistTags(paths.repo, spaceId, 'stable', options.tag)
          await updateDistTags(paths.repo, spaceId, 'latest', options.tag)
        }

        console.log('')
        console.log(chalk.gray('To push the tag:'))
        console.log(chalk.gray(`  cd ${paths.repo} && git push origin ${tagName}`))
      } catch (error) {
        handleCliError(error)
      }
    })
}
