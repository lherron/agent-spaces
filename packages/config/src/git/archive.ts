/**
 * Git archive operations for extracting directory trees.
 *
 * WHY: The store package needs to extract space contents at specific commits
 * into the content-addressed store. Git archive provides an efficient way
 * to extract a subtree without checking out the entire repository.
 */

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Options for archive extraction.
 */
export interface ArchiveOptions {
  /** Working directory containing the git repository */
  cwd?: string | undefined
  /** Prefix to strip from archived paths (useful for extracting subdirectories) */
  prefix?: string | undefined
}

/**
 * Extract a directory tree at a specific commit to a destination path.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param srcPath - Path within the repository to extract (empty string for root)
 * @param destPath - Destination directory path
 * @param options - Archive options including cwd
 * @throws GitError if commit or path doesn't exist
 *
 * @example
 * ```typescript
 * // Extract a space at a specific commit
 * await extractTree('abc123', 'spaces/my-space', '/tmp/extracted', { cwd: repoPath });
 *
 * // Extract entire repo at HEAD
 * await extractTree('HEAD', '', '/tmp/repo-snapshot', { cwd: repoPath });
 * ```
 */
export async function extractTree(
  commitish: string,
  srcPath: string,
  destPath: string,
  options: ArchiveOptions = {}
): Promise<void> {
  const { cwd } = options

  // Ensure destination directory exists
  await mkdir(destPath, { recursive: true })

  // Build archive command
  // git archive outputs a tar stream which we pipe to tar for extraction
  const archiveArgs = ['archive', '--format=tar', commitish]

  // If srcPath is specified, only archive that subtree
  if (srcPath) {
    archiveArgs.push(srcPath)
  }

  // Create archive and extract in one pipeline
  // We use Bun.spawn directly for pipeline support
  const archiveSpawnOpts: {
    cwd?: string
    stdout: 'pipe'
    stderr: 'pipe'
  } = {
    stdout: 'pipe',
    stderr: 'pipe',
  }
  if (cwd !== undefined) {
    archiveSpawnOpts.cwd = cwd
  }
  const archiveProc = Bun.spawn(['git', ...archiveArgs], archiveSpawnOpts)

  // Determine strip-components based on srcPath depth
  const stripComponents = srcPath ? srcPath.split('/').filter(Boolean).length : 0

  const tarArgs = ['-x', '-C', destPath]
  if (stripComponents > 0) {
    tarArgs.push(`--strip-components=${stripComponents}`)
  }

  const tarProc = Bun.spawn(['tar', ...tarArgs], {
    stdin: archiveProc.stdout,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  // Wait for both processes
  const [archiveExitCode, tarExitCode] = await Promise.all([archiveProc.exited, tarProc.exited])

  if (archiveExitCode !== 0) {
    const stderr = await new Response(archiveProc.stderr).text()
    throw new Error(`Git archive failed (exit ${archiveExitCode}): ${stderr.trim()}`)
  }

  if (tarExitCode !== 0) {
    const stderr = await new Response(tarProc.stderr).text()
    throw new Error(`Tar extraction failed (exit ${tarExitCode}): ${stderr.trim()}`)
  }
}

/**
 * Extract a directory tree to a temporary location and return the path.
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param srcPath - Path within the repository to extract
 * @param options - Archive options including cwd
 * @returns Path to the extracted directory
 *
 * @example
 * ```typescript
 * const tmpPath = await extractTreeToTemp('abc123', 'spaces/my-space', { cwd: repoPath });
 * // Use tmpPath...
 * // Remember to clean up when done
 * ```
 */
export async function extractTreeToTemp(
  commitish: string,
  srcPath: string,
  options: ArchiveOptions = {}
): Promise<string> {
  const tmpDir = join(
    process.env['TMPDIR'] || '/tmp',
    `asp-extract-${Date.now()}-${Math.random().toString(36).slice(2)}`
  )
  await extractTree(commitish, srcPath, tmpDir, options)
  return tmpDir
}

/**
 * Get archive as a buffer (useful for streaming or in-memory processing).
 *
 * @param commitish - Commit SHA, tag, or branch reference
 * @param srcPath - Path within the repository to archive
 * @param options - Archive options including cwd
 * @returns Tar archive as a Buffer
 */
export async function getArchiveBuffer(
  commitish: string,
  srcPath: string,
  options: { cwd?: string | undefined } = {}
): Promise<Buffer> {
  const { cwd } = options

  const archiveArgs = ['archive', '--format=tar', commitish]
  if (srcPath) {
    archiveArgs.push(srcPath)
  }

  const bufferSpawnOpts: {
    cwd?: string
    stdout: 'pipe'
    stderr: 'pipe'
  } = {
    stdout: 'pipe',
    stderr: 'pipe',
  }
  if (cwd !== undefined) {
    bufferSpawnOpts.cwd = cwd
  }
  const proc = Bun.spawn(['git', ...archiveArgs], bufferSpawnOpts)

  const exitCode = await proc.exited

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Git archive failed (exit ${exitCode}): ${stderr.trim()}`)
  }

  const arrayBuffer = await new Response(proc.stdout).arrayBuffer()
  return Buffer.from(arrayBuffer)
}
