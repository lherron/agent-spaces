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
import { delimiter, join } from 'node:path'
import { ClaudeNotFoundError } from 'spaces-config'

export const CLAUDE_PATH_ENV = 'ASP_CLAUDE_PATH'
export const CLAUDE_SKIP_COMMON_PATHS_ENV = 'ASP_CLAUDE_SKIP_COMMON_PATHS'

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
  // Homebrew on macOS (Intel) / Linux standard /usr/local
  '/usr/local/bin/claude',
  // Linux standard locations
  '/usr/bin/claude',
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

/** Remove empty and duplicate candidates while retaining first-seen order. */
function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!value || seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function pathCandidatesForCommand(command: string): string[] {
  return (process.env['PATH'] ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, command))
}

/**
 * Enumerate Claude candidates without changing the legacy common-path order.
 *
 * PATH is deliberately a fallback: an existing host that resolves Claude from
 * a common location must keep resolving the same binary after PATH discovery
 * is added.
 */
export function claudeCommandCandidates(): string[] {
  const commonCandidates =
    process.env[CLAUDE_SKIP_COMMON_PATHS_ENV] === '1' ? [] : COMMON_CLAUDE_PATHS

  return dedupeStrings([...commonCandidates, ...pathCandidatesForCommand('claude')])
}

/**
 * Find the claude binary location.
 *
 * Priority:
 * 1. ASP_CLAUDE_PATH environment variable
 * 2. Common installation locations
 * 3. PATH environment variable
 *
 * @returns Absolute path to the claude binary
 * @throws ClaudeNotFoundError if claude cannot be found
 */
export async function findClaudeBinary(): Promise<string> {
  const searchedPaths: string[] = []

  // 1. Check ASP_CLAUDE_PATH environment variable
  const envPath = process.env[CLAUDE_PATH_ENV]
  if (envPath) {
    searchedPaths.push(envPath)
    if (await isExecutable(envPath)) {
      return envPath
    }
    // If ASP_CLAUDE_PATH is set but not found, throw immediately
    throw new ClaudeNotFoundError(searchedPaths)
  }

  // 2. Preserve common-location precedence, then fall back to PATH.
  for (const candidate of claudeCommandCandidates()) {
    searchedPaths.push(candidate)
    if (await isExecutable(candidate)) {
      return candidate
    }
  }

  throw new ClaudeNotFoundError(searchedPaths)
}

/**
 * Sentinel returned when the Claude version cannot be determined.
 */
const UNKNOWN_VERSION = 'unknown'
const VERSION_QUERY_TIMEOUT_MS = 3000

/**
 * Parse a semver version string from `claude --version` output.
 *
 * Common formats: "claude 1.0.0", "Claude Code 1.0.0", etc. Falls back to the
 * trimmed raw output, then to {@link UNKNOWN_VERSION}.
 */
function parseClaudeVersion(stdout: string): string {
  const match = stdout.match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? (stdout.trim() || UNKNOWN_VERSION)
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
      env: claudeDiscoveryEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const stdout = new Response(proc.stdout).text().catch(() => '')
    const exitCode = await exitWithTimeout(proc, VERSION_QUERY_TIMEOUT_MS)
    if (exitCode === undefined) {
      proc.kill()
      return UNKNOWN_VERSION
    }

    if (exitCode !== 0) {
      return UNKNOWN_VERSION
    }

    return parseClaudeVersion(await stdout)
  } catch {
    return UNKNOWN_VERSION
  }
}

async function exitWithTimeout(
  proc: { exited: Promise<number> },
  timeoutMs: number
): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      proc.exited,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, timeoutMs, undefined)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function claudeDiscoveryEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (key.startsWith('HARNESS_BROKER_')) continue
    env[key] = value
  }
  return env
}

/**
 * Detects the Claude installation and caches the result.
 *
 * WHY a class: the detection result is expensive to compute and stable for the
 * life of a process, so it is cached. Owning that cache as instance state (rather
 * than a module-global) makes the seam injectable — tests and alternate call sites
 * can construct an isolated detector instead of mutating shared process state.
 *
 * The module-level functions ({@link detectClaude}, {@link getClaudePath},
 * {@link clearClaudeCache}) delegate to {@link defaultClaudeDetector}, preserving
 * the original behavior and signatures.
 */
export class ClaudeDetector {
  private cachedInfo: ClaudeInfo | null = null

  /**
   * Detect Claude installation and query capabilities.
   *
   * @param forceRefresh - If true, ignore cached info and re-detect
   * @returns Claude installation information
   * @throws ClaudeNotFoundError if claude cannot be found
   */
  async detect(forceRefresh = false): Promise<ClaudeInfo> {
    // Return cached info if available
    if (this.cachedInfo && !forceRefresh) {
      return this.cachedInfo
    }

    const path = await findClaudeBinary()
    const version = await queryVersion(path)

    this.cachedInfo = {
      path,
      version,
      supportsPluginDir: true,
      supportsMcpConfig: true,
    }

    return this.cachedInfo
  }

  /**
   * Get the Claude binary path without full detection.
   * Faster than {@link detect} when you only need the path.
   *
   * @returns Path to claude binary
   * @throws ClaudeNotFoundError if claude cannot be found
   */
  async getPath(): Promise<string> {
    if (this.cachedInfo) {
      return this.cachedInfo.path
    }
    return findClaudeBinary()
  }

  /**
   * Clear the cached Claude info.
   * Useful for testing or after PATH changes.
   */
  clear(): void {
    this.cachedInfo = null
  }
}

/**
 * Process-wide default detector backing the module-level convenience functions.
 */
export const defaultClaudeDetector = new ClaudeDetector()

/**
 * Detect Claude installation and query capabilities.
 *
 * Delegates to {@link defaultClaudeDetector}.
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
export function detectClaude(forceRefresh = false): Promise<ClaudeInfo> {
  return defaultClaudeDetector.detect(forceRefresh)
}

/**
 * Clear the cached Claude info on the default detector.
 * Useful for testing or after PATH changes.
 */
export function clearClaudeCache(): void {
  defaultClaudeDetector.clear()
}

/**
 * Get the Claude binary path without full detection.
 * Faster than detectClaude() when you only need the path.
 *
 * Delegates to {@link defaultClaudeDetector}.
 *
 * @returns Path to claude binary
 * @throws ClaudeNotFoundError if claude cannot be found
 */
export function getClaudePath(): Promise<string> {
  return defaultClaudeDetector.getPath()
}
