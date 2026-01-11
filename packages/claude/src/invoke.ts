/**
 * Claude invocation using safe subprocess execution.
 *
 * WHY: We need to spawn Claude with:
 * - Repeated --plugin-dir flags for each materialized space
 * - Optional --mcp-config for MCP server configuration
 * - Any pass-through arguments from the target configuration
 *
 * Using argv arrays (no shell) prevents command injection vulnerabilities.
 */

import { ClaudeInvocationError } from '@agent-spaces/core'
import { getClaudePath } from './detect.js'

/**
 * Result of a Claude invocation.
 */
export interface ClaudeInvocationResult {
  /** Exit code from the Claude process */
  exitCode: number
  /** Standard output from Claude (if captured) */
  stdout: string
  /** Standard error from Claude (if captured) */
  stderr: string
}

/**
 * Options for invoking Claude.
 */
export interface ClaudeInvokeOptions {
  /** Plugin directories to load (--plugin-dir flags) */
  pluginDirs?: string[] | undefined
  /** Path to MCP config file (--mcp-config flag) */
  mcpConfig?: string | undefined
  /** Model to use (--model flag) */
  model?: string | undefined
  /** Permission mode (--permission-mode flag) */
  permissionMode?: string | undefined
  /** Setting sources to load (--setting-sources flag). Empty string for isolation. */
  settingSources?: string | undefined
  /** Path to settings JSON file or JSON string (--settings flag) */
  settings?: string | undefined
  /** Additional arguments to pass through */
  args?: string[] | undefined
  /** Working directory for Claude */
  cwd?: string | undefined
  /** Environment variables to add/override */
  env?: Record<string, string> | undefined
  /** If true, capture stdout/stderr instead of inheriting */
  captureOutput?: boolean | undefined
  /** Timeout in milliseconds (default: no timeout for interactive use) */
  timeout?: number | undefined
}

/**
 * Quote a string for shell if it contains special characters.
 * Uses single quotes for safety, escaping any embedded single quotes.
 */
function shellQuote(str: string): string {
  // If string contains no special characters, return as-is
  if (/^[a-zA-Z0-9_./-]+$/.test(str)) {
    return str
  }
  // Escape single quotes by ending quote, adding escaped quote, starting new quote
  return `'${str.replace(/'/g, "'\\''")}'`
}

/**
 * Build the argument array for a Claude invocation.
 *
 * @param options - Invocation options
 * @returns Array of arguments (not including 'claude' itself)
 */
export function buildClaudeArgs(options: ClaudeInvokeOptions): string[] {
  const args: string[] = []

  // Add plugin directories
  if (options.pluginDirs) {
    for (const dir of options.pluginDirs) {
      args.push('--plugin-dir', dir)
    }
  }

  // Add MCP config
  if (options.mcpConfig) {
    args.push('--mcp-config', options.mcpConfig)
  }

  // Add model
  if (options.model) {
    args.push('--model', options.model)
  }

  // Add permission mode
  if (options.permissionMode) {
    args.push('--permission-mode', options.permissionMode)
  }

  // Add setting sources for isolation
  if (options.settingSources !== undefined) {
    args.push('--setting-sources', options.settingSources)
  }

  // Add settings file or JSON
  if (options.settings) {
    args.push('--settings', options.settings)
  }

  // Add pass-through arguments
  if (options.args) {
    args.push(...options.args)
  }

  return args
}

/**
 * Format the full Claude command as a shell-executable string.
 *
 * This is useful for --dry-run mode where we want to show the user
 * exactly what command would be executed, in a copy-pasteable format.
 *
 * @param claudePath - Path to the claude binary
 * @param options - Invocation options
 * @returns Shell-safe command string
 *
 * @example
 * ```typescript
 * const command = formatClaudeCommand('/usr/local/bin/claude', {
 *   pluginDirs: ['/path/to/plugin1', '/path with spaces/plugin2'],
 *   mcpConfig: '/path/to/mcp.json',
 * });
 * // Returns: /usr/local/bin/claude --plugin-dir /path/to/plugin1 --plugin-dir '/path with spaces/plugin2' --mcp-config /path/to/mcp.json
 * ```
 */
export function formatClaudeCommand(claudePath: string, options: ClaudeInvokeOptions): string {
  const args = buildClaudeArgs(options)
  const quotedArgs = args.map(shellQuote)
  return [shellQuote(claudePath), ...quotedArgs].join(' ')
}

/**
 * Get the formatted Claude command that would be executed.
 *
 * Async version that resolves the Claude path automatically.
 *
 * @param options - Invocation options
 * @returns Shell-safe command string
 */
export async function getClaudeCommand(options: ClaudeInvokeOptions): Promise<string> {
  const claudePath = await getClaudePath()
  return formatClaudeCommand(claudePath, options)
}

/**
 * Invoke Claude with the specified options.
 *
 * For interactive use, Claude inherits stdin/stdout/stderr.
 * For programmatic use, set captureOutput: true.
 *
 * @param options - Invocation options
 * @returns Result containing exit code and captured output
 * @throws ClaudeInvocationError if Claude fails to start
 *
 * @example
 * ```typescript
 * // Interactive invocation (default)
 * const result = await invokeClaude({
 *   pluginDirs: ['/path/to/plugin1', '/path/to/plugin2'],
 *   mcpConfig: '/path/to/mcp.json',
 * });
 *
 * // Programmatic invocation with captured output
 * const result = await invokeClaude({
 *   args: ['--print', 'Hello'],
 *   captureOutput: true,
 * });
 * console.log(result.stdout);
 * ```
 */
export async function invokeClaude(
  options: ClaudeInvokeOptions = {}
): Promise<ClaudeInvocationResult> {
  const claudePath = await getClaudePath()
  const args = buildClaudeArgs(options)

  const command = [claudePath, ...args]

  try {
    // Build spawn options, only include cwd if defined
    const spawnOptions: {
      cwd?: string
      env?: Record<string, string | undefined>
      stdin: 'pipe' | 'inherit'
      stdout: 'pipe' | 'inherit'
      stderr: 'pipe' | 'inherit'
    } = {
      stdin: options.captureOutput ? 'pipe' : 'inherit',
      stdout: options.captureOutput ? 'pipe' : 'inherit',
      stderr: options.captureOutput ? 'pipe' : 'inherit',
    }

    if (options.cwd !== undefined) {
      spawnOptions.cwd = options.cwd
    }

    if (options.env !== undefined) {
      spawnOptions.env = { ...process.env, ...options.env }
    }

    const proc = Bun.spawn(command, spawnOptions)

    // Handle timeout if specified
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        proc.kill()
      }, options.timeout)
    }

    const exitCode = await proc.exited

    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    let stdout = ''
    let stderr = ''

    if (options.captureOutput) {
      stdout = await new Response(proc.stdout).text()
      stderr = await new Response(proc.stderr).text()
    }

    return {
      exitCode,
      stdout,
      stderr,
    }
  } catch (error) {
    throw new ClaudeInvocationError(-1, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Invoke Claude and throw if it exits with non-zero status.
 *
 * @param options - Invocation options
 * @returns Result containing exit code and captured output
 * @throws ClaudeInvocationError if Claude exits with non-zero status
 */
export async function invokeClaudeOrThrow(
  options: ClaudeInvokeOptions = {}
): Promise<ClaudeInvocationResult> {
  const result = await invokeClaude(options)

  if (result.exitCode !== 0) {
    throw new ClaudeInvocationError(result.exitCode, result.stderr)
  }

  return result
}

/**
 * Run Claude with a prompt and capture output.
 * Convenience wrapper for non-interactive programmatic use.
 *
 * @param prompt - Prompt to send to Claude
 * @param options - Additional invocation options
 * @returns Claude's response
 * @throws ClaudeInvocationError if Claude fails
 *
 * @example
 * ```typescript
 * const response = await runClaudePrompt(
 *   'Explain this code: const x = 1;',
 *   { pluginDirs: ['/path/to/plugin'] }
 * );
 * console.log(response);
 * ```
 */
export async function runClaudePrompt(
  prompt: string,
  options: Omit<ClaudeInvokeOptions, 'captureOutput'> = {}
): Promise<string> {
  const result = await invokeClaudeOrThrow({
    ...options,
    args: [...(options.args || []), '--print', prompt],
    captureOutput: true,
  })

  return result.stdout.trim()
}

/**
 * Options for spawning Claude as a subprocess.
 */
export interface SpawnClaudeOptions extends ClaudeInvokeOptions {
  /** If true, inherit stdio instead of piping (for interactive use) */
  inheritStdio?: boolean | undefined
}

/**
 * Spawn Claude as a subprocess and return the process handle.
 * Use this for long-running or streaming interactions.
 *
 * @param options - Invocation options
 * @returns Bun subprocess handle
 */
export async function spawnClaude(options: SpawnClaudeOptions = {}): Promise<{
  proc: ReturnType<typeof Bun.spawn>
  command: string[]
}> {
  const claudePath = await getClaudePath()
  const args = buildClaudeArgs(options)
  const command = [claudePath, ...args]

  const stdio = options.inheritStdio ? 'inherit' : 'pipe'

  // Build spawn options, only include cwd if defined
  const spawnOptions: {
    cwd?: string
    env?: Record<string, string | undefined>
    stdin: 'pipe' | 'inherit'
    stdout: 'pipe' | 'inherit'
    stderr: 'pipe' | 'inherit'
  } = {
    stdin: stdio,
    stdout: stdio,
    stderr: stdio,
  }

  if (options.cwd !== undefined) {
    spawnOptions.cwd = options.cwd
  }

  if (options.env !== undefined) {
    spawnOptions.env = { ...process.env, ...options.env }
  }

  const proc = Bun.spawn(command, spawnOptions)

  return { proc, command }
}
