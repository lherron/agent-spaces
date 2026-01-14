/**
 * Claude binary detection and version querying.
 *
 * WHY: Before invoking Claude, we need to:
 * 1. Find the claude binary location
 * 2. Verify it's a valid Claude installation
 * 3. Query version and supported flags
 *
 * The ASP_CLAUDE_PATH environment variable allows overriding for testing.
 */

import { constants, access } from 'node:fs/promises'
import { join } from 'node:path'
import { ClaudeNotFoundError } from 'spaces-core'

/**
 * Information about the detected Claude installation.
 */
export interface ClaudeInfo {
  /** Absolute path to the claude binary */
  path: string
  /** Claude version string (e.g., "1.0.0") */
  version: string
  /** Whether --plugin-dir flag is supported */
  supportsPluginDir: boolean
  /** Whether --mcp-config flag is supported */
  supportsMcpConfig: boolean
}

/**
 * Cached Claude info to avoid repeated detection.
 */
let cachedInfo: ClaudeInfo | null = null

/**
 * Get home directory with fallback.
 */
function getHomeDir(): string {
  return process.env['HOME'] || '~'
}

/**
 * Common locations to search for the claude binary.
 */
const COMMON_CLAUDE_PATHS = [
  // Homebrew on macOS (Apple Silicon)
  '/opt/homebrew/bin/claude',
  // Homebrew on macOS (Intel)
  '/usr/local/bin/claude',
  // Linux standard locations
  '/usr/bin/claude',
  '/usr/local/bin/claude',
  // User-local installations
  join(getHomeDir(), '.local/bin/claude'),
  join(getHomeDir(), 'bin/claude'),
  // npm global
  join(getHomeDir(), '.npm-global/bin/claude'),
]

/**
 * Check if a file exists and is executable.
 *
 * @param path - Path to check
 * @returns True if file exists and is executable
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Search PATH for the claude binary.
 *
 * @returns Path to claude binary, or null if not found
 */
async function searchPath(): Promise<string | null> {
  const pathEnv = process.env['PATH'] || ''
  const pathDirs = pathEnv.split(':')

  for (const dir of pathDirs) {
    const claudePath = join(dir, 'claude')
    if (await isExecutable(claudePath)) {
      return claudePath
    }
  }

  return null
}

/**
 * Find the claude binary location.
 *
 * Priority:
 * 1. ASP_CLAUDE_PATH environment variable
 * 2. PATH environment variable
 * 3. Common installation locations
 *
 * @returns Absolute path to the claude binary
 * @throws ClaudeNotFoundError if claude cannot be found
 */
export async function findClaudeBinary(): Promise<string> {
  const searchedPaths: string[] = []

  // 1. Check ASP_CLAUDE_PATH environment variable
  const envPath = process.env['ASP_CLAUDE_PATH']
  if (envPath) {
    searchedPaths.push(envPath)
    if (await isExecutable(envPath)) {
      return envPath
    }
    // If ASP_CLAUDE_PATH is set but not found, throw immediately
    throw new ClaudeNotFoundError(searchedPaths)
  }

  // 2. Search PATH
  const pathResult = await searchPath()
  if (pathResult) {
    return pathResult
  }

  // 3. Check common locations
  for (const commonPath of COMMON_CLAUDE_PATHS) {
    searchedPaths.push(commonPath)
    if (await isExecutable(commonPath)) {
      return commonPath
    }
  }

  throw new ClaudeNotFoundError(searchedPaths)
}

/**
 * Query Claude version by running `claude --version`.
 *
 * @param claudePath - Path to the claude binary
 * @returns Version string
 */
async function queryVersion(claudePath: string): Promise<string> {
  try {
    const proc = Bun.spawn([claudePath, '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()

    if (exitCode !== 0) {
      return 'unknown'
    }

    // Parse version from output (format may vary)
    // Common formats: "claude 1.0.0", "Claude Code 1.0.0", etc.
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? (stdout.trim() || 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a specific flag is supported by running `claude --help`.
 *
 * @param claudePath - Path to the claude binary
 * @param flag - Flag to check (e.g., "--plugin-dir")
 * @returns True if flag is mentioned in help output
 */
async function supportsFlag(claudePath: string, flag: string): Promise<boolean> {
  try {
    const proc = Bun.spawn([claudePath, '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    // We don't care about exit code for --help
    await proc.exited
    const stdout = await new Response(proc.stdout).text()
    const stderr = await new Response(proc.stderr).text()

    const helpText = stdout + stderr
    return helpText.includes(flag)
  } catch {
    // If --help fails, assume flags are supported (conservative)
    return true
  }
}

/**
 * Detect Claude installation and query capabilities.
 *
 * @param forceRefresh - If true, ignore cached info and re-detect
 * @returns Claude installation information
 * @throws ClaudeNotFoundError if claude cannot be found
 *
 * @example
 * ```typescript
 * const info = await detectClaude();
 * console.log(`Found Claude ${info.version} at ${info.path}`);
 * if (info.supportsPluginDir) {
 *   console.log('Plugin support available');
 * }
 * ```
 */
export async function detectClaude(forceRefresh = false): Promise<ClaudeInfo> {
  // Return cached info if available
  if (cachedInfo && !forceRefresh) {
    return cachedInfo
  }

  const path = await findClaudeBinary()
  const version = await queryVersion(path)

  // Check supported flags in parallel
  const [supportsPluginDir, supportsMcpConfig] = await Promise.all([
    supportsFlag(path, '--plugin-dir'),
    supportsFlag(path, '--mcp-config'),
  ])

  cachedInfo = {
    path,
    version,
    supportsPluginDir,
    supportsMcpConfig,
  }

  return cachedInfo
}

/**
 * Clear the cached Claude info.
 * Useful for testing or after PATH changes.
 */
export function clearClaudeCache(): void {
  cachedInfo = null
}

/**
 * Get the Claude binary path without full detection.
 * Faster than detectClaude() when you only need the path.
 *
 * @returns Path to claude binary
 * @throws ClaudeNotFoundError if claude cannot be found
 */
export async function getClaudePath(): Promise<string> {
  if (cachedInfo) {
    return cachedInfo.path
  }
  return findClaudeBinary()
}
