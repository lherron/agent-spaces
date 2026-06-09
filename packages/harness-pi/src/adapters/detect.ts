/**
 * Pi installation detection: locating the binary, querying version, and
 * probing supported flags. Results are cached at module scope.
 */

import { constants, access } from 'node:fs/promises'
import { join } from 'node:path'
import { COMMON_PI_PATHS } from './constants.js'
import { PiNotFoundError } from './errors.js'

/**
 * Information about the detected Pi installation.
 */
export interface PiInfo {
  /** Absolute path to the Pi binary */
  path: string
  /** Pi version string */
  version: string
  /** Whether extensions are supported */
  supportsExtensions: boolean
  /** Whether skills are supported */
  supportsSkills: boolean
}

/**
 * Cached Pi info to avoid repeated detection.
 */
let cachedPiInfo: PiInfo | null = null

/**
 * Check if a file exists and is executable.
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
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Check if `path` is a usable Pi entrypoint: either a real executable, or a
 * `.js` file that exists (run via bun, see `piCommand`). Used by BOTH the PATH
 * search and the common-paths loop so detection is consistent across them.
 */
async function isUsablePiEntrypoint(path: string): Promise<boolean> {
  if (await isExecutable(path)) {
    return true
  }
  // A `.js` entrypoint needn't be marked executable — it is launched with bun.
  return path.endsWith('.js') && (await fileExists(path))
}

/**
 * Search PATH for the Pi binary.
 */
async function searchPath(): Promise<string | null> {
  const pathEnv = process.env['PATH'] || ''
  const pathDirs = pathEnv.split(':')

  for (const dir of pathDirs) {
    // Probe both the bare `pi` executable and a `pi.js` entrypoint so a
    // non-executable `.js` checkout on PATH is detected the same way the
    // common-paths loop accepts one (both go through isUsablePiEntrypoint).
    for (const candidate of [join(dir, 'pi'), join(dir, 'pi.js')]) {
      if (await isUsablePiEntrypoint(candidate)) {
        return candidate
      }
    }
  }

  return null
}

/**
 * Find the Pi binary location.
 *
 * Priority:
 * 1. ASP_PI_PATH environment variable (canonical, mirrors ASP_CLAUDE_PATH/ASP_CODEX_PATH)
 * 2. PI_PATH environment variable (legacy override)
 * 3. PATH environment variable
 * 4. Common installation locations
 */
export async function findPiBinary(): Promise<string> {
  const searchedPaths: string[] = []

  // 1. Check the explicit path overrides (ASP_PI_PATH preferred; PI_PATH legacy).
  const envPath = process.env['ASP_PI_PATH'] ?? process.env['PI_PATH']
  if (envPath) {
    searchedPaths.push(envPath)
    if (await isExecutable(envPath)) {
      return envPath
    }
    // If an explicit override is set but not found, throw immediately
    throw new PiNotFoundError(searchedPaths)
  }

  // 2. Search PATH
  const pathResult = await searchPath()
  if (pathResult) {
    return pathResult
  }

  // 3. Check common locations
  for (const commonPath of COMMON_PI_PATHS) {
    searchedPaths.push(commonPath)
    if (await isUsablePiEntrypoint(commonPath)) {
      return commonPath
    }
  }

  throw new PiNotFoundError(searchedPaths)
}

/**
 * Build the spawn command for invoking Pi, running `.js` entrypoints with bun.
 */
function piCommand(piPath: string, ...rest: string[]): string[] {
  return piPath.endsWith('.js') ? ['bun', piPath, ...rest] : [piPath, ...rest]
}

/**
 * Query Pi version by running `pi --version`.
 */
async function queryPiVersion(piPath: string): Promise<string> {
  try {
    const proc = Bun.spawn(piCommand(piPath, '--version'), {
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const exitCode = await proc.exited
    const stdout = await new Response(proc.stdout).text()

    if (exitCode !== 0) {
      return 'unknown'
    }

    // Parse version from output
    const match = stdout.match(/(\d+\.\d+\.\d+)/)
    return match?.[1] ?? (stdout.trim() || 'unknown')
  } catch {
    return 'unknown'
  }
}

/**
 * Check if a specific flag is supported by running `pi --help`.
 */
async function supportsPiFlag(piPath: string, flag: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(piCommand(piPath, '--help'), {
      stdout: 'pipe',
      stderr: 'pipe',
    })

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
 * Detect Pi installation and query capabilities.
 */
export async function detectPi(forceRefresh = false): Promise<PiInfo> {
  if (cachedPiInfo && !forceRefresh) {
    return cachedPiInfo
  }

  const path = await findPiBinary()
  const version = await queryPiVersion(path)

  // Check supported flags in parallel
  const [supportsExtensions, supportsSkills] = await Promise.all([
    supportsPiFlag(path, '--extension'),
    supportsPiFlag(path, '--skills'),
  ])

  cachedPiInfo = {
    path,
    version,
    supportsExtensions,
    supportsSkills,
  }

  return cachedPiInfo
}

/**
 * Clear the cached Pi info.
 */
export function clearPiCache(): void {
  cachedPiInfo = null
}
