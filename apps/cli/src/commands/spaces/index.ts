/**
 * Spaces commands - Space management in the shared spaces root.
 *
 * WHY: Provides commands for creating and managing spaces
 * in the shared spaces root (the agents root by default).
 */

import type { Command } from 'commander'

import { registerSpacesInitCommand } from './init.js'
import { registerSpacesListCommand } from './list.js'

/**
 * Register all spaces subcommands.
 */
export function registerSpacesCommands(program: Command): void {
  const spaces = program.command('spaces').description('Space management commands')

  registerSpacesInitCommand(spaces)
  registerSpacesListCommand(spaces)
}
