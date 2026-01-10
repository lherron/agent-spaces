/**
 * Lint command - Validate targets and detect conflicts.
 *
 * WHY: Catches potential issues before running, such as command
 * collisions, missing hooks, non-executable scripts, etc.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { explain } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

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
        // Use explain with lint checks to get warnings
        const result = await explain({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: target ? [target] : undefined,
          checkStore: false,
          runLint: true,
        })

        // Collect all warnings
        const allWarnings: Array<{
          target: string
          code: string
          message: string
          severity: string
        }> = []

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

        if (options.json) {
          console.log(JSON.stringify({ warnings: allWarnings }, null, 2))
        } else {
          if (allWarnings.length === 0) {
            console.log(chalk.green('No warnings found'))
          } else {
            console.log(chalk.yellow(`Found ${allWarnings.length} warning(s):\n`))
            for (const warning of allWarnings) {
              console.log(`[${warning.code}] ${warning.target}`)
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
