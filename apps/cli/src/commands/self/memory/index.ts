/**
 * `asp self memory` — manage the three agent memory targets (memory, user, persona).
 *
 * Subcommands: inspect, read, add, replace, remove, scan, snapshot, diff, paths.
 * All accept --json for structured output.
 */

import type { Command } from 'commander'

import { registerMemoryAddCommand } from './add.js'
import { registerMemoryDiffCommand } from './diff-cmd.js'
import { registerMemoryInspectCommand } from './inspect.js'
import { registerMemoryPathsCommand } from './paths-cmd.js'
import { registerMemoryReadCommand } from './read.js'
import { registerMemoryRemoveCommand } from './remove.js'
import { registerMemoryReplaceCommand } from './replace.js'
import { registerMemoryScanCommand } from './scan-cmd.js'
import { registerMemorySnapshotCommand } from './snapshot-cmd.js'

export function registerSelfMemoryCommand(parent: Command): void {
  const memory = parent
    .command('memory')
    .description('Manage agent memory targets (memory, user, persona)')

  registerMemoryInspectCommand(memory)
  registerMemoryReadCommand(memory)
  registerMemoryAddCommand(memory)
  registerMemoryReplaceCommand(memory)
  registerMemoryRemoveCommand(memory)
  registerMemoryScanCommand(memory)
  registerMemorySnapshotCommand(memory)
  registerMemoryDiffCommand(memory)
  registerMemoryPathsCommand(memory)
}
