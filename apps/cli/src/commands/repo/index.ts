/**
 * Repo commands - shared spaces root management.
 *
 * WHY: Shared spaces live as plain directories under the shared spaces root
 * (the agents root by default). The git registry these commands used to manage
 * (release tags, dist-tags, `asp repo publish/tags/gc`) was retired in T-04144.
 */

import type { Command } from 'commander'

import { registerRepoInitCommand } from './init.js'
import { registerRepoNewSpaceCommand } from './new-space.js'
import { registerRepoStatusCommand } from './status.js'

/**
 * Register all repo subcommands.
 */
export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Shared spaces root commands')

  registerRepoInitCommand(repo)
  registerRepoNewSpaceCommand(repo)
  registerRepoStatusCommand(repo)
}
