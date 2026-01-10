/**
 * Explain command - Print resolved graph, pins, load order, warnings.
 *
 * WHY: Provides visibility into how targets are resolved and what
 * plugins will be loaded. Essential for debugging and understanding
 * the space composition.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { explain, formatExplainJson, formatExplainText } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the explain command.
 */
export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('Print resolved graph, pins, load order, and warnings')
    .argument('[target]', 'Specific target to explain (default: all)')
    .option('--json', 'Output as JSON')
    .option('--no-store-check', 'Skip checking if snapshots are in store')
    .option('--no-lint', 'Skip lint checks')
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
        const result = await explain({
          projectPath,
          aspHome: options.aspHome,
          registryPath: options.registry,
          targets: target ? [target] : undefined,
          checkStore: options.storeCheck !== false,
          runLint: options.lint !== false,
        })

        if (options.json) {
          console.log(formatExplainJson(result))
        } else {
          console.log(formatExplainText(result))
        }
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
