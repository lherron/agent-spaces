/**
 * Central command registration.
 *
 * WHY: `createProgram()` in index.ts previously imported and called ~21
 * register functions inline. Collecting them here keeps the program-creation
 * path focused on Commander wiring and makes adding a command a single-file
 * change (import + push into the list below).
 */

import type { Command } from 'commander'

import { registerAddCommand } from './commands/add.js'
import { registerAgentCommands } from './commands/agent/index.js'
import { registerAgentInspectionCommands } from './commands/agents.js'
import { registerBuildCommand } from './commands/build.js'
import { registerDescribeCommand } from './commands/describe.js'
import { registerDiffCommand } from './commands/diff.js'
import { registerDoctorCommand } from './commands/doctor.js'
import { registerExplainCommand } from './commands/explain.js'
import { registerGcCommand } from './commands/gc.js'
import { registerGuiCommand } from './commands/gui.js'
import { registerHarnessesCommand } from './commands/harnesses.js'
import { registerInitCommand } from './commands/init.js'
import { registerInstallCommand } from './commands/install.js'
import { registerLintCommand } from './commands/lint.js'
import { registerListCommand } from './commands/list.js'
import { registerPathCommand } from './commands/path.js'
import { registerRemoveCommand } from './commands/remove.js'
import { registerRepoCommands } from './commands/repo/index.js'
import { registerResolveReminderCommand } from './commands/resolve-reminder.js'
import { registerResourcesCommands } from './commands/resources/index.js'
import { registerRunCommand } from './commands/run.js'
import { registerSelfCommands } from './commands/self/index.js'
import { registerSpacesCommands } from './commands/spaces/index.js'
import { registerTokenRentCommand } from './commands/token-rent.js'
import { registerUpgradeCommand } from './commands/upgrade.js'

/**
 * A function that registers one or more subcommands onto the root program.
 */
type RegisterCommandFn = (program: Command) => void

/**
 * Registration functions in their canonical order (matches help output).
 */
const COMMAND_REGISTRARS: readonly RegisterCommandFn[] = [
  registerRunCommand,
  registerInitCommand,
  registerInstallCommand,
  registerBuildCommand,
  registerDescribeCommand,
  registerExplainCommand,
  registerLintCommand,
  registerListCommand,
  registerPathCommand,
  registerDoctorCommand,
  registerGcCommand,
  registerGuiCommand,
  registerAddCommand,
  registerRemoveCommand,
  registerUpgradeCommand,
  registerDiffCommand,
  registerHarnessesCommand,
  registerResolveReminderCommand,
  registerSelfCommands,
  registerRepoCommands,
  registerSpacesCommands,
  registerResourcesCommands,
  registerAgentCommands,
  registerAgentInspectionCommands,
  registerTokenRentCommand,
]

/**
 * Register every CLI command onto the given program.
 */
export function registerAllCommands(program: Command): void {
  for (const register of COMMAND_REGISTRARS) {
    register(program)
  }
}
