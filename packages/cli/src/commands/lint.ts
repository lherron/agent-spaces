/**
 * Lint command - Validate targets and detect conflicts.
 *
 * WHY: Catches potential issues before running, such as command
 * collisions, missing hooks, non-executable scripts, etc.
 */

import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import { LOCK_FILENAME, explain, lockFileExists } from 'spaces-config'

import { type CommonOptions, exitWithAspError, getProjectContext } from '../helpers.js'
import { type HygieneCliOptions, runHygieneCommand, runJudgeCommand } from './lint-hygiene.js'

/** W101 warning code for missing lock file */
const WARNING_CODE_LOCK_MISSING = 'W101'

/**
 * CLI-local lint row.
 *
 * Distinct from the canonical `LintWarning` (spaces-config): this adds a
 * `target` column and deliberately widens `severity` to `string` to carry the
 * synthetic 'info' W101 lock warning. Renamed from `LintWarning` so the
 * divergence from the upstream type is intentional and visible, not a shadow.
 */
interface LintRow {
  target: string
  code: string
  message: string
  severity: string
  spaceKey?: string | undefined
  path?: string | undefined
}

/**
 * Check for missing lock file and return warning if applicable.
 */
async function checkLockFile(projectPath: string): Promise<LintRow | null> {
  const lockPath = join(projectPath, LOCK_FILENAME)
  const hasLock = await lockFileExists(lockPath)

  if (!hasLock) {
    return {
      target: '_project',
      code: WARNING_CODE_LOCK_MISSING,
      message: `Lock file (${LOCK_FILENAME}) not found. Run "asp install" to generate it, or "asp run" will generate it automatically.`,
      severity: 'info',
      path: lockPath,
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
): Promise<LintRow[]> {
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

  const warnings: LintRow[] = []
  for (const [targetName, explanation] of Object.entries(result.targets)) {
    for (const warning of explanation.warnings) {
      warnings.push({
        target: targetName,
        code: warning.code,
        message: warning.message,
        severity: warning.severity ?? 'warning',
        spaceKey: warning.spaceKey,
        path: warning.path,
      })
    }
  }

  return warnings
}

/**
 * Format and output warnings as text.
 */
function outputWarningsText(warnings: LintRow[]): void {
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
    const label = warning.spaceKey ? `${target} (${warning.spaceKey})` : target
    console.log(color(`[${warning.code}] ${label}`))
    console.log(`  ${warning.message}`)
    if (warning.path) {
      console.log(`  ${warning.path}`)
    }
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
    .option(
      '--hygiene [path]',
      'Run agent-hygiene lint (W4xx) over a skill / prompt / agent root / var/agents tree'
    )
    .option('--strict', 'With --hygiene: exit nonzero on error-severity findings')
    .option('--baseline <path>', 'With --hygiene: baseline file for suppression')
    .option('--update-baseline', 'With --hygiene: (re)write the baseline from current findings')
    .option(
      '--judge <path>',
      'Run the tier-2 rubric judge over one unit; emit the §7 JSON scorecard'
    )
    .option('--agent-hygiene-root <path>', 'Override the agent-hygiene criteria source root')
    .action(async (target: string | undefined, options: CommonOptions & HygieneCliOptions) => {
      try {
        // Tier-2 judge mode.
        if (options.judge !== undefined) {
          process.exit(await runJudgeCommand(options.judge, options))
        }
        // Tier-1 hygiene mode.
        if (options.hygiene !== undefined) {
          const path = typeof options.hygiene === 'string' ? options.hygiene : target
          process.exit(await runHygieneCommand(path, options))
        }

        const ctx = await getProjectContext(options)
        const allWarnings: LintRow[] = []

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
        exitWithAspError(error, options)
      }
    })
}
