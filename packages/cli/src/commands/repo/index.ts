/**
 * Repo commands - Registry/repository management.
 *
 * WHY: Provides commands for initializing, managing, and publishing
 * to the spaces registry.
 */

import type { Command } from 'commander'

import { registerRepoGcCommand } from './gc.js'
import { registerRepoInitCommand } from './init.js'
import { registerRepoPublishCommand } from './publish.js'
import { registerRepoStatusCommand } from './status.js'
import { registerRepoTagsCommand } from './tags.js'

/**
 * Register all repo subcommands.
 */
export function registerRepoCommands(program: Command): void {
  const repo = program.command('repo').description('Registry/repository management commands')

  registerRepoInitCommand(repo)
  registerRepoStatusCommand(repo)
  registerRepoPublishCommand(repo)
  registerRepoTagsCommand(repo)
  registerRepoGcCommand(repo)
}
