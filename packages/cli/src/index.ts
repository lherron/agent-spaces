/**
 * @agent-spaces/cli - Command line interface for Agent Spaces v2.
 *
 * WHY: Provides a thin argument parsing layer that delegates
 * all core logic to the engine package. This keeps the CLI
 * focused on user interaction while engine handles orchestration.
 */

import chalk from 'chalk'
import { Command } from 'commander'

import { isAspError } from '@agent-spaces/core'

import { registerAddCommand } from './commands/add.js'
import { registerBuildCommand } from './commands/build.js'
import { registerDiffCommand } from './commands/diff.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerExplainCommand } from './commands/explain.js'
import { registerGcCommand } from './commands/gc.js'
import { registerHarnessesCommand } from './commands/harnesses.js'
import { registerInitCommand } from './commands/init.js'
import { registerInstallCommand } from './commands/install.js'
import { registerLintCommand } from './commands/lint.js'
import { registerListCommand } from './commands/list.js'
import { registerPathCommand } from './commands/path.js'
import { registerRemoveCommand } from './commands/remove.js'
import { registerRepoCommands } from './commands/repo/index.js'
import { registerRunCommand } from './commands/run.js'
import { registerSpacesCommands } from './commands/spaces/index.js'
import { registerUpgradeCommand } from './commands/upgrade.js'

/**
 * Find project root by walking up looking for asp-targets.toml.
 */
export async function findProjectRoot(startDir: string = process.cwd()): Promise<string | null> {
  let dir = startDir
  const root = '/'

  while (dir !== root) {
    const targetsPath = `${dir}/asp-targets.toml`
    try {
      await Bun.file(targetsPath).exists()
      const exists = await Bun.file(targetsPath).exists()
      if (exists) {
        return dir
      }
    } catch {
      // Continue searching
    }
    // Move to parent directory
    const parent = dir.split('/').slice(0, -1).join('/')
    if (parent === dir || parent === '') {
      break
    }
    dir = parent || '/'
  }

  return null
}

/**
 * Format error for display.
 */
function formatError(error: unknown): string {
  if (isAspError(error)) {
    const lines: string[] = [chalk.red(`Error: ${error.message}`)]
    if (error.cause && error.cause instanceof Error) {
      lines.push(chalk.gray(`  Cause: ${error.cause.message}`))
    }
    return lines.join('\n')
  }

  if (error instanceof Error) {
    return chalk.red(`Error: ${error.message}`)
  }

  return chalk.red(`Error: ${String(error)}`)
}

/**
 * Create the CLI program.
 */
function createProgram(): Command {
  const program = new Command()
    .name('asp')
    .description('Agent Spaces v2 - Compose Claude Code environments')
    .version('0.0.1')

  // Register all commands
  registerRunCommand(program)
  registerInitCommand(program)
  registerInstallCommand(program)
  registerBuildCommand(program)
  registerExplainCommand(program)
  registerLintCommand(program)
  registerListCommand(program)
  registerPathCommand(program)
  registerDoctorCommand(program)
  registerGcCommand(program)
  registerAddCommand(program)
  registerRemoveCommand(program)
  registerUpgradeCommand(program)
  registerDiffCommand(program)
  registerHarnessesCommand(program)
  registerRepoCommands(program)
  registerSpacesCommands(program)

  return program
}

/**
 * Main entry point.
 */
export async function main(): Promise<void> {
  const program = createProgram()

  try {
    await program.parseAsync(process.argv)
  } catch (error) {
    console.error(formatError(error))
    process.exit(1)
  }
}

// Only run if this is the main module (not imported in tests)
if (import.meta.main) {
  main().catch((error) => {
    console.error(formatError(error))
    process.exit(1)
  })
}
