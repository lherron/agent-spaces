/**
 * Explain command - Print resolved graph, pins, load order, warnings.
 *
 * WHY: Provides visibility into how targets are resolved and what
 * plugins will be loaded. Essential for debugging and understanding
 * the space composition.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import {
  type HarnessId,
  explain,
  formatExplainJson,
  formatExplainText,
  harnessRegistry,
  isHarnessId,
} from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Validate harness option and return the harness ID.
 * In Phase 1, only 'claude' is supported.
 */
function validateHarness(harness: string | undefined): HarnessId {
  const harnessId = harness ?? 'claude'

  if (!isHarnessId(harnessId)) {
    console.error(chalk.red(`Error: Unknown harness "${harnessId}"`))
    console.error(chalk.gray(''))
    console.error(chalk.gray('Available harnesses:'))
    for (const adapter of harnessRegistry.getAll()) {
      console.error(chalk.gray(`  - ${adapter.id}`))
    }
    process.exit(1)
  }

  // Phase 1: Only claude is supported
  if (harnessId !== 'claude') {
    console.error(chalk.red(`Error: Harness "${harnessId}" is not yet supported`))
    console.error(chalk.gray('Currently only "claude" is available.'))
    console.error(chalk.gray('Run "asp harnesses" to see available harnesses.'))
    process.exit(1)
  }

  return harnessId
}

/**
 * Register the explain command.
 */
export function registerExplainCommand(program: Command): void {
  program
    .command('explain')
    .description('Print resolved graph, pins, load order, and warnings')
    .argument('[target]', 'Specific target to explain (default: all)')
    .option('--harness <id>', 'Coding agent harness to use (default: claude)')
    .option('--json', 'Output as JSON')
    .option('--no-store-check', 'Skip checking if snapshots are in store')
    .option('--no-lint', 'Skip lint checks')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (target: string | undefined, options) => {
      // Validate harness option (Phase 1: only claude supported)
      const _harness = validateHarness(options.harness)
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
