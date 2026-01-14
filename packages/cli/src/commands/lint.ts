/**
 * Lint command - Validate targets and detect conflicts.
 *
 * WHY: Catches potential issues before running, such as command
 * collisions, missing hooks, non-executable scripts, etc.
 */

import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import { LOCK_FILENAME, lockFileExists } from 'spaces-core'
import { explain } from 'spaces-engine'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

/** W101 warning code for missing lock file */
const WARNING_CODE_LOCK_MISSING = 'W101'

/**
 * Lint warning structure.
 */
interface LintWarning {
  target: string
  code: string
  message: string
  severity: string
}

/**
 * Check for missing lock file and return warning if applicable.
 */
async function checkLockFile(projectPath: string): Promise<LintWarning | null> {
  const lockPath = join(projectPath, LOCK_FILENAME)
  const hasLock = await lockFileExists(lockPath)

  if (!hasLock) {
    return {
      target: '_project',
      code: WARNING_CODE_LOCK_MISSING,
      message: `Lock file (${LOCK_FILENAME}) not found. Run "asp install" to generate it, or "asp run" will generate it automatically.`,
      severity: 'info',
    }
  }
  return null
}

/**
 * Collect warnings from explain result.
 */
async function collectExplainWarnings(
  projectPath: string,
  options: {
    aspHome?: string | undefined
    registry?: string | undefined
    target?: string | undefined
  }
): Promise<LintWarning[]> {
  const lockPath = join(projectPath, LOCK_FILENAME)
  const hasLock = await lockFileExists(lockPath)

  if (!hasLock) {
    return []
  }

  const result = await explain({
    projectPath,
    aspHome: options.aspHome,
    registryPath: options.registry,
    targets: options.target ? [options.target] : undefined,
    checkStore: false,
    runLint: true,
  })

  const warnings: LintWarning[] = []
  for (const [targetName, explanation] of Object.entries(result.targets)) {
    for (const warning of explanation.warnings) {
      warnings.push({
        target: targetName,
        code: warning.code,
        message: warning.message,
        severity: warning.severity ?? 'warning',
      })
    }
  }

  return warnings
}

/**
 * Format and output warnings as text.
 */
function outputWarningsText(warnings: LintWarning[]): void {
  if (warnings.length === 0) {
    console.log(chalk.green('No warnings found'))
    return
  }

  const warningCount = warnings.filter((w) => w.severity === 'warning').length
  const infoCount = warnings.filter((w) => w.severity === 'info').length

  const parts: string[] = []
  if (warningCount > 0) parts.push(`${warningCount} warning(s)`)
  if (infoCount > 0) parts.push(`${infoCount} info`)

  console.log(chalk.yellow(`Found ${parts.join(', ')}:\n`))

  for (const warning of warnings) {
    const color = warning.severity === 'info' ? chalk.blue : chalk.yellow
    const target = warning.target === '_project' ? 'project' : warning.target
    console.log(color(`[${warning.code}] ${target}`))
    console.log(`  ${warning.message}`)
    console.log('')
  }
}

/**
 * Register the lint command.
 */
export function registerLintCommand(program: Command): void {
  program
    .command('lint')
    .description('Validate targets and detect conflicts')
    .argument('[target]', 'Specific target to lint (default: all)')
    .option('--json', 'Output as JSON')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (target: string | undefined, options: CommonOptions) => {
      try {
        const ctx = await getProjectContext(options)
        const allWarnings: LintWarning[] = []

        // Check for missing lock file
        const lockWarning = await checkLockFile(ctx.projectPath)
        if (lockWarning) {
          allWarnings.push(lockWarning)
        }

        // Collect warnings from explain
        const explainWarnings = await collectExplainWarnings(ctx.projectPath, {
          aspHome: ctx.aspHome,
          registry: ctx.registryPath,
          target,
        })
        allWarnings.push(...explainWarnings)

        // Output results
        if (options.json) {
          console.log(JSON.stringify({ warnings: allWarnings }, null, 2))
        } else {
          outputWarningsText(allWarnings)
        }

        // Exit with code 0 since warnings are non-fatal
        process.exit(0)
      } catch (error) {
        handleCliError(error)
      }
    })
}
