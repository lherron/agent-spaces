/**
 * Git archive operations for extracting directory trees.
 *
 * WHY: The store package needs to extract space contents at specific commits
 * into the content-addressed store. Git archive provides an efficient way
 * to extract a subtree without checking out the entire repository.
 */

import { spawn } from 'node:child_process'
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
  // Use spawn directly for pipeline support
  const archiveSpawnOpts: {
    cwd?: string
    stdio: ['ignore', 'pipe', 'pipe']
  } = {
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  if (cwd !== undefined) {
    archiveSpawnOpts.cwd = cwd
  }
  const archiveProc = spawn('git', archiveArgs, archiveSpawnOpts)

  // Determine strip-components based on srcPath depth
  const stripComponents = srcPath ? srcPath.split('/').filter(Boolean).length : 0

  const tarArgs = ['-x', '-C', destPath]
  if (stripComponents > 0) {
    tarArgs.push(`--strip-components=${stripComponents}`)
  }

  const tarProc = spawn('tar', tarArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (archiveProc.stdout && tarProc.stdin) {
    archiveProc.stdout.pipe(tarProc.stdin)
  }

  let archiveStderr = ''
  let tarStderr = ''
  archiveProc.stderr?.on('data', (data) => {
    archiveStderr += data.toString()
  })
  tarProc.stderr?.on('data', (data) => {
    tarStderr += data.toString()
  })

  // Wait for both processes
  const [archiveExitCode, tarExitCode] = await Promise.all([
    new Promise<number>((resolve) => {
      archiveProc.on('close', (code) => resolve(typeof code === 'number' ? code : -1))
    }),
    new Promise<number>((resolve) => {
      tarProc.on('close', (code) => resolve(typeof code === 'number' ? code : -1))
    }),
  ])

  if (archiveExitCode !== 0) {
    throw new Error(`Git archive failed (exit ${archiveExitCode}): ${archiveStderr.trim()}`)
  }

  if (tarExitCode !== 0) {
    throw new Error(`Tar extraction failed (exit ${tarExitCode}): ${tarStderr.trim()}`)
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
    stdio: ['ignore', 'pipe', 'pipe']
  } = {
    stdio: ['ignore', 'pipe', 'pipe'],
  }
  if (cwd !== undefined) {
    bufferSpawnOpts.cwd = cwd
  }
  const proc = spawn('git', archiveArgs, bufferSpawnOpts)

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  proc.stdout?.on('data', (data) => {
    stdoutChunks.push(Buffer.from(data))
  })
  proc.stderr?.on('data', (data) => {
    stderrChunks.push(Buffer.from(data))
  })

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', (code) => resolve(typeof code === 'number' ? code : -1))
  })

  if (exitCode !== 0) {
    const stderr = Buffer.concat(stderrChunks).toString()
    throw new Error(`Git archive failed (exit ${exitCode}): ${stderr.trim()}`)
  }

  return Buffer.concat(stdoutChunks)
}
