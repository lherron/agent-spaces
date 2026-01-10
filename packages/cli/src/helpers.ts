/**
 * Shared CLI helper utilities.
 *
 * WHY: Reduces cognitive complexity across CLI commands by extracting
 * common patterns like project context resolution, error handling,
 * and output formatting into reusable functions.
 */

import chalk from 'chalk'

import { PathResolver, getAspHome } from '@agent-spaces/store'

import { findProjectRoot } from './index.js'

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
 * Get resolved project context from CLI options.
 * Throws if project root cannot be found.
 */
export async function getProjectContext(options: CommonOptions): Promise<ProjectContext> {
  const projectPath = options.project ?? (await findProjectRoot())
  if (!projectPath) {
    throw new ProjectNotFoundError()
  }

  const aspHome = options.aspHome ?? getAspHome()
  const paths = new PathResolver({ aspHome })
  const registryPath = options.registry ?? paths.repo

  return { projectPath, aspHome, paths, registryPath }
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
 * Handle CLI errors with consistent formatting.
 * Prints error message and exits with code 1.
 */
export function handleCliError(error: unknown): never {
  if (error instanceof ProjectNotFoundError) {
    console.error(chalk.red(`Error: ${error.message}`))
    console.error(chalk.gray('Run this command from a project directory or use --project'))
  } else if (error instanceof Error) {
    console.error(chalk.red(`Error: ${error.message}`))
  } else {
    console.error(chalk.red(`Error: ${String(error)}`))
  }
  process.exit(1)
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
