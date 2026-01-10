/**
 * Run command - Launch Claude with composed plugin directories.
 *
 * WHY: This is the primary command users interact with. It resolves
 * a target, materializes plugins to a temp directory, and launches
 * Claude with all the plugin directories.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { runInteractive, runWithPrompt } from '@agent-spaces/engine'

import { findProjectRoot } from '../index.js'

/**
 * Register the run command.
 */
export function registerRunCommand(program: Command): void {
  program
    .command('run')
    .description('Run Claude with a target, space reference, or filesystem path')
    .argument('<target>', 'Target name from asp-targets.toml, space:id@selector, or path')
    .argument('[prompt]', 'Optional initial prompt (runs non-interactively)')
    .option('--no-interactive', 'Run non-interactively (requires prompt)')
    .option('--no-warnings', 'Suppress lint warnings')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .option('--extra-args <args...>', 'Additional Claude CLI arguments')
    .action(async (target: string, prompt: string | undefined, options) => {
      // Find project root
      const projectPath = options.project ?? (await findProjectRoot())
      if (!projectPath) {
        console.error(chalk.red('Error: No asp-targets.toml found in current directory or parents'))
        console.error(chalk.gray('Run this command from a project directory or use --project'))
        process.exit(1)
      }

      const runOptions = {
        projectPath,
        aspHome: options.aspHome,
        registryPath: options.registry,
        printWarnings: options.warnings !== false,
        extraArgs: options.extraArgs,
      }

      try {
        let result
        if (prompt) {
          // Non-interactive with prompt
          console.log(chalk.blue(`Running target "${target}" with prompt...`))
          result = await runWithPrompt(target, prompt, runOptions)

          // Print output
          if (result.invocation?.stdout) {
            console.log(result.invocation.stdout)
          }
          if (result.invocation?.stderr) {
            console.error(result.invocation.stderr)
          }
        } else if (options.interactive === false) {
          console.error(chalk.red('Error: --no-interactive requires a prompt'))
          process.exit(1)
        } else {
          // Interactive mode
          console.log(chalk.blue(`Running target "${target}" interactively...`))
          console.log(chalk.gray('Press Ctrl+C to exit'))
          console.log('')
          result = await runInteractive(target, runOptions)
        }

        process.exit(result.exitCode)
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
