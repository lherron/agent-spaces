/**
 * Git show operations for reading file contents at specific commits.
 *
 * WHY: The resolver needs to read files like `registry/dist-tags.json`
 * at specific commits to resolve dist-tag selectors without checking
 * out the entire repository.
 */

import { gitExec, gitExecStdout } from './exec.js'

/**
 * Read file contents at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the file within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns File contents as a string
 * @throws GitError if file doesn't exist at that commit
 *
 * @example
 * ```typescript
 * // Read dist-tags.json at HEAD
 * const content = await showFile('HEAD', 'registry/dist-tags.json', { cwd: repoPath });
 *
 * // Read space.toml at a specific commit
 * const content = await showFile('abc123', 'spaces/my-space/space.toml', { cwd: repoPath });
 *
 * // Read from a tag
 * const content = await showFile('space/my-space/v1.0.0', 'spaces/my-space/space.toml', { cwd: repoPath });
 * ```
 */
export async function showFile(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<string> {
  // git show <commit>:<path> retrieves file contents
  return gitExecStdout(['show', `${commitish}:${path}`], options)
}

/**
 * Read file contents at a specific commit, returning null if file doesn't exist.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the file within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns File contents as a string, or null if file doesn't exist
 *
 * @example
 * ```typescript
 * const content = await showFileOrNull('HEAD', 'maybe/missing.txt', { cwd: repoPath });
 * if (content !== null) {
 *   // File exists
 * }
 * ```
 */
export async function showFileOrNull(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<string | null> {
  const result = await gitExec(['show', `${commitish}:${path}`], {
    ...options,
    ignoreExitCode: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout
}

/**
 * Check if a file exists at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the file within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns True if file exists, false otherwise
 *
 * @example
 * ```typescript
 * if (await fileExistsAtCommit('HEAD', 'spaces/my-space/space.toml', { cwd: repoPath })) {
 *   // Space exists at HEAD
 * }
 * ```
 */
export async function fileExistsAtCommit(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<boolean> {
  // Use cat-file -e to check existence (faster than show for just checking)
  const result = await gitExec(['cat-file', '-e', `${commitish}:${path}`], {
    ...options,
    ignoreExitCode: true,
  })
  return result.exitCode === 0
}

/**
 * Get the object type (blob, tree, commit, tag) at a path for a given commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns Object type string, or null if path doesn't exist
 */
export async function getObjectType(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<'blob' | 'tree' | 'commit' | 'tag' | null> {
  const result = await gitExec(['cat-file', '-t', `${commitish}:${path}`], {
    ...options,
    ignoreExitCode: true,
  })

  if (result.exitCode !== 0) {
    return null
  }

  return result.stdout.trim() as 'blob' | 'tree' | 'commit' | 'tag'
}

/**
 * Read and parse a JSON file at a specific commit.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the JSON file within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns Parsed JSON object
 * @throws GitError if file doesn't exist
 * @throws SyntaxError if JSON is invalid
 *
 * @example
 * ```typescript
 * const distTags = await showJson<{ [id: string]: { stable?: string } }>(
 *   'HEAD',
 *   'registry/dist-tags.json',
 *   { cwd: repoPath }
 * );
 * ```
 */
export async function showJson<T>(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<T> {
  const content = await showFile(commitish, path, options)
  return JSON.parse(content) as T
}

/**
 * Read and parse a JSON file at a specific commit, returning null if missing or invalid.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param path - Path to the JSON file within the repository
 * @param options - Execution options including cwd (repo root)
 * @returns Parsed JSON object, or null if file doesn't exist or JSON is invalid
 */
export async function showJsonOrNull<T>(
  commitish: string,
  path: string,
  options: { cwd?: string | undefined } = {}
): Promise<T | null> {
  const content = await showFileOrNull(commitish, path, options)
  if (content === null) {
    return null
  }

  try {
    return JSON.parse(content) as T
  } catch {
    return null
  }
}
