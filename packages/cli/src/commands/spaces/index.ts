/**
 * Spaces commands - Space management in the registry.
 *
 * WHY: Provides commands for creating and managing spaces
 * in the local registry.
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
