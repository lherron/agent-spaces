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

import { registerAllCommands } from './command-registry.js'
import { exitWithAspError } from './helpers.js'

export { findProjectRoot } from './lib.js'

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
  registerAllCommands(program)

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
