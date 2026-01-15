/**
 * Git tag operations for space versioning.
 *
 * WHY: Spaces are versioned using git tags in two forms:
 * - Semver tags: space/<id>/vX.Y.Z (immutable)
 * - Dist-tags: space/<id>/<tag> (mutable, e.g., stable, latest, beta)
 *
 * These tags are used by the resolver to map selectors to specific commits.
 */

import { gitExec, gitExecLines, gitExecStdout } from './exec.js'

/**
 * Parsed git tag with associated commit.
 */
export interface GitTag {
  /** Full tag name (e.g., "space/my-space/v1.0.0") */
  name: string
  /** Commit SHA the tag points to */
  commit: string
}

/**
 * List git tags matching a pattern.
 *
 * @param pattern - Glob pattern to match (e.g., "space/my-space/v*")
 * @param options - Execution options including cwd
 * @returns Array of tag names matching the pattern
 *
 * @example
 * ```typescript
 * // List all semver tags for a space
 * const tags = await listTags('space/todo-frontend/v*', { cwd: repoPath });
 * // ['space/todo-frontend/v1.0.0', 'space/todo-frontend/v1.1.0', ...]
 * ```
 */
export async function listTags(
  pattern: string,
  options: { cwd?: string | undefined } = {}
): Promise<string[]> {
  return gitExecLines(['tag', '-l', pattern], options)
}

/**
 * List git tags with their commit SHAs.
 *
 * @param pattern - Glob pattern to match (e.g., "space/my-space/v*")
 * @param options - Execution options including cwd
 * @returns Array of GitTag objects with name and commit
 *
 * @example
 * ```typescript
 * const tags = await listTagsWithCommits('space/todo-frontend/v*', { cwd: repoPath });
 * // [{ name: 'space/todo-frontend/v1.0.0', commit: 'abc123...' }, ...]
 * ```
 */
export async function listTagsWithCommits(
  pattern: string,
  options: { cwd?: string | undefined } = {}
): Promise<GitTag[]> {
  // Use --format to get tag name and dereferenced commit SHA
  // %(objectname) gives the tag object SHA, %(*objectname) gives the commit for annotated tags
  // For lightweight tags, %(objectname) is the commit SHA directly
  const lines = await gitExecLines(
    [
      'tag',
      '-l',
      pattern,
      '--format=%(refname:short) %(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)',
    ],
    options
  )

  return lines.map((line) => {
    const parts = line.split(' ')
    const name = parts[0] ?? ''
    const commit = parts[1] ?? ''
    return { name, commit }
  })
}

/**
 * Get the commit SHA for a specific tag.
 *
 * @param tagName - Full tag name (e.g., "space/my-space/v1.0.0")
 * @param options - Execution options including cwd
 * @returns Commit SHA the tag points to
 * @throws GitError if tag doesn't exist
 *
 * @example
 * ```typescript
 * const commit = await getTagCommit('space/todo-frontend/v1.0.0', { cwd: repoPath });
 * // 'abc123def456...'
 * ```
 */
export async function getTagCommit(
  tagName: string,
  options: { cwd?: string | undefined } = {}
): Promise<string> {
  // Use rev-parse to resolve tag to commit SHA
  // ^{} dereferences to the commit for annotated tags
  return gitExecStdout(['rev-parse', `${tagName}^{}`], options)
}

/**
 * Check if a tag exists.
 *
 * @param tagName - Full tag name to check
 * @param options - Execution options including cwd
 * @returns True if tag exists, false otherwise
 */
export async function tagExists(
  tagName: string,
  options: { cwd?: string | undefined } = {}
): Promise<boolean> {
  const result = await gitExec(['tag', '-l', tagName], {
    ...options,
    ignoreExitCode: true,
  })
  return result.stdout.trim() === tagName
}

/**
 * Create a lightweight tag pointing to a commit.
 *
 * @param tagName - Full tag name to create (e.g., "space/my-space/v1.0.0")
 * @param commit - Commit SHA to tag (defaults to HEAD)
 * @param options - Execution options including cwd
 * @throws GitError if tag already exists or commit is invalid
 *
 * @example
 * ```typescript
 * // Tag current HEAD
 * await createTag('space/my-space/v1.0.0', undefined, { cwd: repoPath });
 *
 * // Tag specific commit
 * await createTag('space/my-space/v1.0.0', 'abc123', { cwd: repoPath });
 * ```
 */
export async function createTag(
  tagName: string,
  commit?: string | undefined,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  const args = ['tag', tagName]
  if (commit) {
    args.push(commit)
  }
  await gitExec(args, options)
}

/**
 * Create an annotated tag with a message.
 *
 * @param tagName - Full tag name to create
 * @param message - Tag message
 * @param commit - Commit SHA to tag (defaults to HEAD)
 * @param options - Execution options including cwd
 * @throws GitError if tag already exists or commit is invalid
 */
export async function createAnnotatedTag(
  tagName: string,
  message: string,
  commit?: string | undefined,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  const args = ['tag', '-a', tagName, '-m', message]
  if (commit) {
    args.push(commit)
  }
  await gitExec(args, options)
}

/**
 * Delete a tag (local only).
 *
 * @param tagName - Full tag name to delete
 * @param options - Execution options including cwd
 * @throws GitError if tag doesn't exist
 */
export async function deleteTag(
  tagName: string,
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['tag', '-d', tagName], options)
}

/**
 * Push a tag to remote.
 *
 * @param tagName - Full tag name to push
 * @param remote - Remote name (defaults to "origin")
 * @param options - Execution options including cwd
 * @throws GitError if push fails
 */
export async function pushTag(
  tagName: string,
  remote = 'origin',
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['push', remote, `refs/tags/${tagName}`], options)
}

/**
 * Delete a tag from remote.
 *
 * @param tagName - Full tag name to delete
 * @param remote - Remote name (defaults to "origin")
 * @param options - Execution options including cwd
 * @throws GitError if deletion fails
 */
export async function deleteRemoteTag(
  tagName: string,
  remote = 'origin',
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['push', remote, `:refs/tags/${tagName}`], options)
}

/**
 * Fetch tags from remote.
 *
 * @param remote - Remote name (defaults to "origin")
 * @param options - Execution options including cwd
 * @throws GitError if fetch fails
 */
export async function fetchTags(
  remote = 'origin',
  options: { cwd?: string | undefined } = {}
): Promise<void> {
  await gitExec(['fetch', remote, '--tags'], options)
}
