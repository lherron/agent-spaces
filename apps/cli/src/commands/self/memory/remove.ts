/**
 * `asp self memory remove` — remove an entry by substring match from a memory target.
 */

import type { Command } from 'commander'

import type { MemoryTargetName } from 'spaces-runtime'

import { type StoreFailure, requireOption, validateTarget, withMemoryStore } from './lib.js'

interface RemoveOptions {
  json?: boolean
  target?: string
  match?: string
}

const COMMAND_NAME = 'self memory remove'

export function registerMemoryRemoveCommand(parent: Command): void {
  parent
    .command('remove')
    .description('Remove an entry by substring match from a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--match <text>', 'Substring to locate the entry to remove')
    .action(async (options: RemoveOptions) => {
      await withMemoryStore(COMMAND_NAME, async (store) => {
        requireOption(COMMAND_NAME, 'target', options.target)
        validateTarget(COMMAND_NAME, options.target)

        requireOption(COMMAND_NAME, 'match', options.match)

        const result = await store.remove({
          target: options.target as MemoryTargetName,
          old: options.match,
        })

        if (result.ok) {
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
          } else {
            process.stdout.write(`Removed entry from ${options.target}\n`)
          }
          return
        }

        // Handle failures
        const output = mapRemoveError(result)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`${COMMAND_NAME}: ${output.error}\n`)
        }
        process.exit(1)
      })
    })
}

function mapRemoveError(result: StoreFailure): {
  ok: false
  error: string
  [key: string]: unknown
} {
  if ('error' in result && result.error === 'ambiguous_match') {
    return { ok: false, error: 'ambiguous_match', matches: result.matches.length }
  }
  if ('error' in result && result.error === 'not_found') {
    return { ok: false, error: 'no_match' }
  }
  return { ok: false, error: 'unknown' }
}
