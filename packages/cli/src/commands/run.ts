/**
 * Run command - Launch Claude with composed plugin directories.
 *
 * WHY: This is the primary command users interact with. It resolves
 * a target, materializes plugins to a temp directory, and launches
 * Claude with all the plugin directories.
 *
 * Supports three modes:
 * 1. Project mode: Run a target from asp-targets.toml
 * 2. Global mode: Run a space reference (space:id@selector) without a project
 * 3. Dev mode: Run a local space directory (./path/to/space)
 */

import { stat } from 'node:fs/promises'
import { resolve } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import {
  type RunResult,
  isSpaceReference,
  runGlobalSpace,
  runInteractive,
  runLocalSpace,
  runWithPrompt,
} from '@agent-spaces/engine'

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

      try {
        let result: RunResult

        // Determine run mode
        if (projectPath) {
          // Project mode: run a target from asp-targets.toml
          const runOptions = {
            projectPath,
            aspHome: options.aspHome,
            registryPath: options.registry,
            printWarnings: options.warnings !== false,
            extraArgs: options.extraArgs,
          }

          if (prompt) {
            console.log(chalk.blue(`Running target "${target}" with prompt...`))
            result = await runWithPrompt(target, prompt, runOptions)
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
            console.log(chalk.blue(`Running target "${target}" interactively...`))
            console.log(chalk.gray('Press Ctrl+C to exit'))
            console.log('')
            result = await runInteractive(target, runOptions)
          }
        } else if (isSpaceReference(target)) {
          // Global mode: run a space reference from registry
          console.log(chalk.blue(`Running space "${target}" in global mode...`))

          const globalOptions = {
            aspHome: options.aspHome,
            registryPath: options.registry,
            printWarnings: options.warnings !== false,
            extraArgs: options.extraArgs,
            interactive: options.interactive !== false,
            prompt,
          }

          result = await runGlobalSpace(target, globalOptions)

          if (result.invocation?.stdout) {
            console.log(result.invocation.stdout)
          }
          if (result.invocation?.stderr) {
            console.error(result.invocation.stderr)
          }
        } else {
          // Check if target is a local path to a space directory
          const targetPath = resolve(target)
          let isLocalSpace = false

          try {
            const stats = await stat(targetPath)
            if (stats.isDirectory()) {
              // Check if space.toml exists
              try {
                await stat(resolve(targetPath, 'space.toml'))
                isLocalSpace = true
              } catch {
                // No space.toml, not a space directory
              }
            }
          } catch {
            // Path doesn't exist
          }

          if (isLocalSpace) {
            // Dev mode: run a local space directory
            console.log(chalk.blue(`Running local space "${target}" in dev mode...`))

            const devOptions = {
              aspHome: options.aspHome,
              registryPath: options.registry,
              printWarnings: options.warnings !== false,
              extraArgs: options.extraArgs,
              interactive: options.interactive !== false,
              prompt,
            }

            result = await runLocalSpace(targetPath, devOptions)

            if (result.invocation?.stdout) {
              console.log(result.invocation.stdout)
            }
            if (result.invocation?.stderr) {
              console.error(result.invocation.stderr)
            }
          } else {
            // Not in a project, not a space ref, not a local path
            console.error(
              chalk.red(
                'Error: No asp-targets.toml found and target is not a valid space reference or path'
              )
            )
            console.error(chalk.gray(''))
            console.error(chalk.gray('Usage:'))
            console.error(chalk.gray('  In a project: asp run <target-name>'))
            console.error(chalk.gray('  Global mode:  asp run space:my-space@stable'))
            console.error(chalk.gray('  Dev mode:     asp run ./path/to/space'))
            process.exit(1)
          }
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
