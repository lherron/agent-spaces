/**
 * Doctor command - Check Claude, registry, cache permissions.
 *
 * WHY: Diagnoses common setup issues before users try to run,
 * providing clear guidance on what needs to be fixed.
 */

import { constants, access } from 'node:fs/promises'
import type { Command } from 'commander'

import { detectClaude } from '@agent-spaces/claude'
import { gitExec, listRemotes } from '@agent-spaces/git'
import { PathResolver, ensureAspHome, getAspHome } from '@agent-spaces/store'

import { formatCheckResults, outputDoctorSummary } from '../helpers.js'
import { findProjectRoot } from '../index.js'

interface CheckResult {
  name: string
  status: 'ok' | 'warning' | 'error'
  message: string
  detail?: string | undefined
}

/**
 * Check Claude binary availability.
 */
async function checkClaude(): Promise<CheckResult> {
  try {
    const claude = await detectClaude()
    return {
      name: 'claude',
      status: 'ok',
      message: `Claude found at ${claude.path}`,
      detail: `Version: ${claude.version ?? 'unknown'}`,
    }
  } catch (error) {
    return {
      name: 'claude',
      status: 'error',
      message: 'Claude not found',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check ASP_HOME directory.
 */
async function checkAspHome(aspHome: string): Promise<CheckResult> {
  try {
    await ensureAspHome()
    return {
      name: 'asp_home',
      status: 'ok',
      message: `ASP_HOME: ${aspHome}`,
    }
  } catch (error) {
    return {
      name: 'asp_home',
      status: 'error',
      message: `Cannot create ASP_HOME: ${aspHome}`,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check directory access (read/write).
 */
async function checkDirectoryAccess(name: string, dirPath: string): Promise<CheckResult> {
  const displayName = name.charAt(0).toUpperCase() + name.slice(1)

  try {
    await access(dirPath, constants.W_OK)
    return {
      name,
      status: 'ok',
      message: `${displayName} directory writable: ${dirPath}`,
    }
  } catch {
    try {
      await access(dirPath, constants.R_OK)
      return {
        name,
        status: 'warning',
        message: `${displayName} directory read-only: ${dirPath}`,
      }
    } catch {
      return {
        name,
        status: 'ok',
        message: `${displayName} directory will be created: ${dirPath}`,
      }
    }
  }
}

/**
 * Check if registry exists.
 */
async function checkRegistry(repoPath: string): Promise<{ result: CheckResult; exists: boolean }> {
  try {
    await access(repoPath, constants.R_OK)
    return {
      result: {
        name: 'registry',
        status: 'ok',
        message: `Registry found: ${repoPath}`,
      },
      exists: true,
    }
  } catch {
    return {
      result: {
        name: 'registry',
        status: 'warning',
        message: 'No local registry found',
        detail: `Expected at: ${repoPath}. Run 'asp repo init' to create one.`,
      },
      exists: false,
    }
  }
}

/**
 * Check registry remote reachability.
 */
async function checkRegistryRemote(repoPath: string): Promise<CheckResult> {
  try {
    const remotes = await listRemotes({ cwd: repoPath })
    const origin = remotes.find((r) => r.name === 'origin')

    if (!origin?.fetchUrl) {
      return {
        name: 'registry_remote',
        status: 'warning',
        message: 'No remote configured for registry',
        detail: 'The registry is local-only. Add a remote with git remote add origin <url>.',
      }
    }

    // Try to connect to remote using ls-remote (with timeout)
    const result = await gitExec(['ls-remote', '--heads', origin.fetchUrl], {
      cwd: repoPath,
      timeout: 10000, // 10 second timeout
      ignoreExitCode: true,
    })

    if (result.exitCode === 0) {
      return {
        name: 'registry_remote',
        status: 'ok',
        message: `Registry remote reachable: ${origin.fetchUrl}`,
      }
    }

    return {
      name: 'registry_remote',
      status: 'warning',
      message: `Registry remote unreachable: ${origin.fetchUrl}`,
      detail: 'Check your network connection or remote URL configuration.',
    }
  } catch (error) {
    return {
      name: 'registry_remote',
      status: 'warning',
      message: 'Could not check registry remote',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * Check project directory.
 */
function checkProject(projectPath: string | null): CheckResult {
  if (projectPath) {
    return {
      name: 'project',
      status: 'ok',
      message: `Project found: ${projectPath}`,
    }
  }
  return {
    name: 'project',
    status: 'warning',
    message: 'No project found in current directory',
    detail: 'Run this command from a project directory with asp-targets.toml',
  }
}

/**
 * Register the doctor command.
 */
export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check Claude binary, registry reachability, and cache permissions')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (options) => {
      const checks: CheckResult[] = []

      // Check Claude binary
      checks.push(await checkClaude())

      // Check ASP_HOME
      const aspHome = options.aspHome ?? getAspHome()
      const paths = new PathResolver({ aspHome })
      checks.push(await checkAspHome(aspHome))

      // Check cache directory
      checks.push(await checkDirectoryAccess('cache', paths.cache))

      // Check store directory
      checks.push(await checkDirectoryAccess('store', paths.store))

      // Check registry
      const { result: registryResult, exists: registryExists } = await checkRegistry(paths.repo)
      checks.push(registryResult)

      // Check registry remote reachability (if registry exists)
      if (registryExists) {
        checks.push(await checkRegistryRemote(paths.repo))
      }

      // Check project
      const projectPath = options.project ?? (await findProjectRoot())
      checks.push(checkProject(projectPath))

      // Output results
      const { hasError, hasWarning } = formatCheckResults(checks, options)
      if (!options.json) {
        outputDoctorSummary(hasError, hasWarning)
      } else if (hasError) {
        process.exit(1)
      }
    })
}
