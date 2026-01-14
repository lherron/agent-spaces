/**
 * Safe git command execution using argv arrays (no shell interpolation).
 *
 * WHY: Shell interpolation can lead to command injection vulnerabilities.
 * By using argv arrays directly with Bun.spawn, we ensure git commands
 * are executed safely without shell interpretation of special characters.
 */

import { GitError } from 'spaces-core'

/**
 * Result of a git command execution.
 */
export interface GitExecResult {
  /** Exit code from the git process */
  exitCode: number
  /** Standard output from the command */
  stdout: string
  /** Standard error from the command */
  stderr: string
}

/**
 * Options for git command execution.
 */
export interface GitExecOptions {
  /** Working directory for the command (defaults to cwd) */
  cwd?: string | undefined
  /** Environment variables to pass to the process */
  env?: Record<string, string> | undefined
  /** Timeout in milliseconds (default: 60000ms = 1 minute) */
  timeout?: number | undefined
  /** If true, don't throw on non-zero exit code */
  ignoreExitCode?: boolean | undefined
}

/**
 * Execute a git command safely using argv array (no shell).
 *
 * @param args - Array of arguments to pass to git (not including 'git' itself)
 * @param options - Execution options
 * @returns Result containing exitCode, stdout, and stderr
 * @throws GitError if the command fails (unless ignoreExitCode is true)
 *
 * @example
 * ```typescript
 * // List tags
 * const result = await gitExec(['tag', '-l', 'space/my-space/v*']);
 *
 * // Get file content at commit
 * const result = await gitExec(['show', 'abc123:path/to/file.json']);
 *
 * // Clone a repository
 * const result = await gitExec(['clone', url, destPath], { cwd: '/tmp' });
 * ```
 */
export async function gitExec(
  args: string[],
  options: GitExecOptions = {}
): Promise<GitExecResult> {
  const { cwd, env, timeout = 60000, ignoreExitCode = false } = options

  const command = ['git', ...args]

  // Build spawn options, only include cwd if defined
  const spawnOptions: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdout: 'pipe'
    stderr: 'pipe'
  } = {
    stdout: 'pipe',
    stderr: 'pipe',
  }

  if (cwd !== undefined) {
    spawnOptions.cwd = cwd
  }

  if (env !== undefined) {
    spawnOptions.env = { ...process.env, ...env }
  }

  const proc = Bun.spawn(command, spawnOptions)

  // Handle timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill()
      reject(new GitError(command.join(' '), -1, `Timeout exceeded (${timeout}ms)`))
    }, timeout)
  })

  try {
    // Wait for process to complete or timeout
    const exitCode = await Promise.race([proc.exited, timeoutPromise])

    // Clear timeout since process completed
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    // Read stdout and stderr
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    const result: GitExecResult = {
      exitCode,
      stdout,
      stderr,
    }

    // Throw error on non-zero exit code unless ignoreExitCode is true
    if (exitCode !== 0 && !ignoreExitCode) {
      throw new GitError(command.join(' '), exitCode, stderr || stdout)
    }

    return result
  } catch (error) {
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    // Re-throw GitError as-is
    if (error instanceof GitError) {
      throw error
    }

    // Wrap other errors
    throw new GitError(
      command.join(' '),
      -1,
      error instanceof Error ? error.message : String(error)
    )
  }
}

/**
 * Execute a git command and return stdout, trimming trailing whitespace.
 * Convenience wrapper for simple commands where only stdout matters.
 *
 * @param args - Array of arguments to pass to git
 * @param options - Execution options
 * @returns Trimmed stdout string
 * @throws GitError if the command fails
 */
export async function gitExecStdout(args: string[], options: GitExecOptions = {}): Promise<string> {
  const result = await gitExec(args, options)
  return result.stdout.trim()
}

/**
 * Execute a git command and return stdout lines as an array.
 * Empty lines are filtered out.
 *
 * @param args - Array of arguments to pass to git
 * @param options - Execution options
 * @returns Array of non-empty stdout lines
 * @throws GitError if the command fails
 */
export async function gitExecLines(
  args: string[],
  options: GitExecOptions = {}
): Promise<string[]> {
  const stdout = await gitExecStdout(args, options)
  if (!stdout) {
    return []
  }
  return stdout.split('\n').filter((line) => line.length > 0)
}
