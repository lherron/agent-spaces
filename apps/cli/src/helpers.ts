/**
 * Shared CLI helper utilities.
 *
 * WHY: Reduces cognitive complexity across CLI commands by extracting
 * common patterns like project context resolution, error handling,
 * and output formatting into reusable functions.
 */

import chalk from 'chalk'
import { CliUsageError, exitWithError } from 'cli-kit'

import { PathResolver, getAspHome, getRegistryPath, isAspError } from 'spaces-config'

import { findProjectRoot } from './lib.js'

/**
 * Common CLI options that most commands accept.
 */
export interface CommonOptions {
  project?: string | undefined
  aspHome?: string | undefined
  registry?: string | undefined
  json?: boolean | undefined
}

/**
 * Resolved project context for CLI commands.
 */
export interface ProjectContext {
  projectPath: string
  aspHome: string
  paths: PathResolver
  registryPath: string
}

/**
 * Resolved path context (project-independent) for CLI commands.
 */
export interface PathContext {
  aspHome: string
  paths: PathResolver
  registryPath: string
}

/**
 * Resolve the shared ASP_HOME / PathResolver / registry path from CLI options.
 *
 * WHY: Commands need the same ASP_HOME paths and shared-space root. Routing
 * them through this single factory gives one construction seam and removes the
 * duplication.
 */
export function resolvePaths(options: CommonOptions): PathContext {
  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = getRegistryPath({
    projectPath: process.cwd(),
    aspHome,
    ...(options.registry ? { registryPath: options.registry } : {}),
  })
  return { aspHome, paths, registryPath }
}

/**
 * Get resolved project context from CLI options.
 * Throws if project root cannot be found.
 */
export async function getProjectContext(options: CommonOptions): Promise<ProjectContext> {
  const projectPath = options.project ?? (await findProjectRoot())
  if (!projectPath) {
    throw new ProjectNotFoundError()
  }

  return { projectPath, ...resolvePaths(options) }
}

/**
 * Normalize an unknown thrown value into a human-readable message.
 *
 * Replaces the `error instanceof Error ? error.message : String(error)`
 * idiom duplicated across the command handlers.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Format a byte count as a human-readable string (e.g. "1.5 MB").
 *
 * Shared by the project-level (`asp gc`) and registry-level (`asp repo gc`)
 * garbage-collection commands, which previously carried byte-for-byte copies.
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex++
  }

  return `${value.toFixed(1)} ${units[unitIndex]}`
}

/**
 * Print the standard "no project found" error block (chalk variant).
 *
 * Shared by the chalk-based commands (`asp explain`, `asp add`) that do their
 * own `findProjectRoot` lookup instead of routing through `getProjectContext`
 * / `ProjectNotFoundError`. The message text matches that error contract.
 */
export function printNoProjectError(): void {
  console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
  console.error(chalk.gray('Run this command from a project directory or use --project'))
}

/**
 * Error thrown when no project root can be found.
 */
export class ProjectNotFoundError extends Error {
  constructor() {
    super('No asp-targets.toml found in current directory or parents')
    this.name = 'ProjectNotFoundError'
  }
}

/**
 * Wrap an `AspError` that carries an `Error` cause into a flattened
 * `Error` whose message appends the cause. Non-asp errors (and asp errors
 * without an `Error` cause) are returned unchanged.
 *
 * Shared by the `helpers`/`index` error-normalization paths, which both
 * applied this identical formatting branch.
 */
export function formatAspErrorCause(error: unknown): unknown {
  if (isAspError(error) && error.cause instanceof Error) {
    return new Error(`${error.message}\n  Cause: ${error.cause.message}`)
  }
  return error
}

function normalizeCliError(error: unknown): unknown {
  if (error instanceof ProjectNotFoundError) {
    return new CliUsageError(
      `${error.message}\nRun this command from a project directory or use --project`
    )
  }

  return formatAspErrorCause(error)
}

/**
 * Exit with the shared cli-kit error contract.
 */
export function exitWithAspError(
  error: unknown,
  options: { json?: boolean | undefined } = {}
): never {
  exitWithError(normalizeCliError(error), { json: options.json ?? false, binName: 'asp' })
}

/**
 * Log invocation output (stdout/stderr) from a run result.
 */
export function logInvocationOutput(
  invocation: { stdout?: string; stderr?: string } | undefined
): void {
  if (!invocation) return
  if (invocation.stdout) {
    console.log(invocation.stdout)
  }
  if (invocation.stderr) {
    console.error(invocation.stderr)
  }
}

/**
 * Get status icon for doctor check results.
 */
export function getStatusIcon(status: 'ok' | 'warning' | 'error'): string {
  switch (status) {
    case 'ok':
      return chalk.green('✓')
    case 'warning':
      return chalk.yellow('!')
    case 'error':
      return chalk.red('✗')
  }
}

/**
 * Get chalk color function for status.
 */
export function getStatusColor(status: 'ok' | 'warning' | 'error'): (text: string) => string {
  switch (status) {
    case 'ok':
      return chalk.green
    case 'warning':
      return chalk.yellow
    case 'error':
      return chalk.red
  }
}

/**
 * Format and output check results for doctor command.
 */
export function formatCheckResults(
  checks: Array<{
    name: string
    status: 'ok' | 'warning' | 'error'
    message: string
    detail?: string | undefined
  }>,
  options: { json?: boolean | undefined }
): { hasError: boolean; hasWarning: boolean } {
  if (options.json) {
    console.log(JSON.stringify({ checks }, null, 2))
    return {
      hasError: checks.some((c) => c.status === 'error'),
      hasWarning: checks.some((c) => c.status === 'warning'),
    }
  }

  console.log(chalk.blue('Agent Spaces Doctor\n'))

  let hasError = false
  let hasWarning = false

  for (const check of checks) {
    const icon = getStatusIcon(check.status)
    const color = getStatusColor(check.status)

    console.log(`${icon} ${color(check.message)}`)
    if (check.detail) {
      console.log(`  ${chalk.gray(check.detail)}`)
    }

    if (check.status === 'error') hasError = true
    if (check.status === 'warning') hasWarning = true
  }

  return { hasError, hasWarning }
}

/**
 * Output final doctor summary.
 */
export function outputDoctorSummary(hasError: boolean, hasWarning: boolean): void {
  console.log('')
  if (hasError) {
    console.log(chalk.red('Some checks failed. Please fix the issues above.'))
    process.exit(1)
  } else if (hasWarning) {
    console.log(chalk.yellow('Some warnings found. Review the messages above.'))
  } else {
    console.log(chalk.green('All checks passed!'))
  }
}
