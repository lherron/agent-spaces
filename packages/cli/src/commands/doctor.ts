/**
 * Doctor command - Check Claude, registry, cache permissions.
 *
 * WHY: Diagnoses common setup issues before users try to run,
 * providing clear guidance on what needs to be fixed.
 */

import { existsSync, readFileSync } from 'node:fs'
import { constants, access } from 'node:fs/promises'
import { join } from 'node:path'
import type { Command } from 'commander'

import { ensureAspHome, gitExec, listRemotes } from 'spaces-config'
import { detectClaude } from 'spaces-execution'

import { SHARED_AGENT_ROOT_FILES, buildAgentRootReport } from '../agent-roots.js'
import { errorMessage, formatCheckResults, outputDoctorSummary, resolvePaths } from '../helpers.js'
import { findProjectRoot } from '../lib.js'

/** Timeout for the registry-remote `git ls-remote` reachability probe. */
const REGISTRY_REMOTE_TIMEOUT_MS = 10_000

interface CheckResult {
  name: string
  status: 'ok' | 'warning' | 'error'
  message: string
  detail?: string | undefined
}

interface ContextTemplateNudge {
  path: string
  refs: string[]
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
      detail: errorMessage(error),
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
      detail: errorMessage(error),
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
      timeout: REGISTRY_REMOTE_TIMEOUT_MS,
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
      detail: errorMessage(error),
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

function checkAgentRoots(projectPath: string | null, aspHome: string): CheckResult[] {
  if (!projectPath) {
    return []
  }
  const report = buildAgentRootReport(projectPath, { aspHome })
  const checks: CheckResult[] = []

  for (const warning of report.searchPath.warnings) {
    checks.push({
      name: 'agents_root',
      status: 'error',
      message: warning.message,
      detail: `Declared as agents-root = "${warning.declaredPath}" in ${warning.projectRoot}/asp-targets.toml; canonical agents remain usable.`,
    })
  }

  for (const agent of report.agents) {
    for (const shadowedRoot of agent.shadowedRoots) {
      checks.push({
        name: 'agent_shadow',
        status: 'warning',
        message: `agent '${agent.id}' resolved from ${agent.root}`,
        detail: `shadows ${shadowedRoot}`,
      })
    }
  }

  for (const override of report.sharedFileOverrides) {
    checks.push({
      name: 'shared_file_override',
      status: 'warning',
      message: `${override.file} resolved from ${override.resolvedPath}`,
      detail: `shadows ${override.shadowedPath}`,
    })
  }

  for (const nudge of findContextTemplateSchemeNudges(report.searchPath.roots)) {
    checks.push({
      name: 'context_template_refs',
      status: 'ok',
      message: 'Context template can make shared-file refs explicit with agents-root:///',
      detail: `${nudge.path}: ${nudge.refs
        .map((ref) => `${ref} -> agents-root:///${ref}`)
        .join(', ')}`,
    })
  }

  if (checks.length === 0) {
    checks.push({
      name: 'agents_root',
      status: 'ok',
      message: `Agent roots checked: ${report.searchPath.roots.join(', ') || '(none)'}`,
    })
  }

  return checks
}

function findContextTemplateSchemeNudges(roots: string[]): ContextTemplateNudge[] {
  const nudges: ContextTemplateNudge[] = []
  const sharedFiles = SHARED_AGENT_ROOT_FILES.filter((file) => file !== 'context-template.toml')

  for (const root of roots) {
    const templatePath = join(root, 'context-template.toml')
    if (!existsSync(templatePath)) {
      continue
    }

    let content: string
    try {
      content = readFileSync(templatePath, 'utf8')
    } catch {
      continue
    }

    const refs = sharedFiles.filter((file) =>
      new RegExp(`^\\s*path\\s*=\\s*["']${escapeRegExp(file)}["']\\s*$`, 'm').test(content)
    )
    if (refs.length > 0) {
      nudges.push({ path: templatePath, refs })
    }
  }

  return nudges
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
      const { aspHome, paths } = resolvePaths(options)
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
      checks.push(...checkAgentRoots(projectPath, aspHome))

      // Output results
      const { hasError, hasWarning } = formatCheckResults(checks, options)
      if (!options.json) {
        outputDoctorSummary(hasError, hasWarning)
      } else if (hasError) {
        process.exit(1)
      }
    })
}
