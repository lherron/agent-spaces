/**
 * Lint command - Validate targets and detect conflicts.
 *
 * WHY: Catches potential issues before running, such as command
 * collisions, missing hooks, non-executable scripts, etc.
 */

import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'

import { LOCK_FILENAME, lockFileExists } from '@agent-spaces/core'
import { explain } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/** W301 warning code for missing lock file */
const WARNING_CODE_LOCK_MISSING = 'W301'

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
    .action(async (target: string | undefined, options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      try {
        // Collect all warnings
        const allWarnings: Array<{
          target: string
          code: string
          message: string
          severity: string
        }> = []

        // Check for missing lock file (W301)
        const lockPath = join(projectPath, LOCK_FILENAME)
        const hasLock = await lockFileExists(lockPath)

        if (!hasLock) {
          // W301: Lock file missing
          allWarnings.push({
            target: '_project',
            code: WARNING_CODE_LOCK_MISSING,
            message:
              `Lock file (${LOCK_FILENAME}) not found. ` +
              'Run "asp install" to generate it, or "asp run" will generate it automatically.',
            severity: 'info',
          })
        }

        // If lock exists, run full lint checks via explain
        if (hasLock) {
          const result = await explain({
            projectPath,
            aspHome: options.aspHome,
            registryPath: options.registry,
            targets: target ? [target] : undefined,
            checkStore: false,
            runLint: true,
          })

          for (const [targetName, explanation] of Object.entries(result.targets)) {
            for (const warning of explanation.warnings) {
              allWarnings.push({
                target: targetName,
                code: warning.code,
                message: warning.message,
                severity: warning.severity ?? 'warning',
              })
            }
          }
        }

        if (options.json) {
          console.log(JSON.stringify({ warnings: allWarnings }, null, 2))
        } else {
          if (allWarnings.length === 0) {
            console.log(chalk.green('No warnings found'))
          } else {
            const warningCount = allWarnings.filter((w) => w.severity === 'warning').length
            const infoCount = allWarnings.filter((w) => w.severity === 'info').length

            const parts: string[] = []
            if (warningCount > 0) parts.push(`${warningCount} warning(s)`)
            if (infoCount > 0) parts.push(`${infoCount} info`)

            console.log(chalk.yellow(`Found ${parts.join(', ')}:\n`))

            for (const warning of allWarnings) {
              const color = warning.severity === 'info' ? chalk.blue : chalk.yellow
              const target = warning.target === '_project' ? 'project' : warning.target
              console.log(color(`[${warning.code}] ${target}`))
              console.log(`  ${warning.message}`)
              console.log('')
            }
          }
        }

        // Exit with code 0 since warnings are non-fatal
        process.exit(0)
      } catch (error) {
        if (error instanceof Error) {
          console.error(chalk.red(`Error: ${error.message}`))
        } else {
          console.error(chalk.red(`Error: ${String(error)}`))
        }
        process.exit(1)
      }
    })
}
