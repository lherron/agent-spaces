/**
 * @lherron/agent-spaces - Command line interface for Agent Spaces v2.
 *
 * WHY: Provides a thin argument parsing layer that delegates
 * all core logic to the engine package. This keeps the CLI
 * focused on user interaction while engine handles orchestration.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CliUsageError, exitWithError } from 'cli-kit'
import { Command, CommanderError } from 'commander'

import { isAspError } from 'spaces-config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const packageJson = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
  version: string
}

import { registerAddCommand } from './commands/add.js'
import { registerAgentCommands } from './commands/agent/index.js'
import { registerBuildCommand } from './commands/build.js'
import { registerDescribeCommand } from './commands/describe.js'
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
import { registerResolveReminderCommand } from './commands/resolve-reminder.js'
import { registerRunCommand } from './commands/run.js'
import { registerSelfCommands } from './commands/self/index.js'
import { registerSpacesCommands } from './commands/spaces/index.js'
import { registerUpgradeCommand } from './commands/upgrade.js'
import { exitWithAspError } from './helpers.js'

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

function normalizeMainError(error: unknown): unknown {
  if (isAspError(error)) {
    if (error.cause && error.cause instanceof Error) {
      return new Error(`${error.message}\n  Cause: ${error.cause.message}`)
    }
    return error
  }

  return error
}

/**
 * Create the CLI program.
 */
function createProgram(): Command {
  const program = new Command()
    .name('asp')
    .description('Agent Spaces v2 - Compose Claude Code environments')
    .version(packageJson.version)
    .enablePositionalOptions()
    .exitOverride((err) => {
      throw err
    })

  // Register all commands
  registerRunCommand(program)
  registerInitCommand(program)
  registerInstallCommand(program)
  registerBuildCommand(program)
  registerDescribeCommand(program)
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
  registerResolveReminderCommand(program)
  registerSelfCommands(program)
  registerRepoCommands(program)
  registerSpacesCommands(program)
  registerAgentCommands(program)

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
    if (error instanceof CommanderError) {
      if (
        error.code === 'commander.helpDisplayed' ||
        error.code === 'commander.help' ||
        error.code === 'commander.version'
      ) {
        process.exit(0)
      }
      exitWithError(new CliUsageError(error.message), { json: false, binName: 'asp' })
    }

    if (error instanceof CliUsageError) {
      exitWithError(error, { json: false, binName: 'asp' })
    }

    exitWithAspError(normalizeMainError(error))
  }
}

// Only run if this is the main module (not imported in tests)
if (import.meta.main) {
  main().catch((error) => {
    exitWithAspError(normalizeMainError(error))
  })
}
