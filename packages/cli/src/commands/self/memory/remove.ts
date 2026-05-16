/**
 * `asp self memory remove` — remove an entry by substring match from a memory target.
 */

import type { Command } from 'commander'

import { MemoryStore, type MemoryTargetName, type StoreResult } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface RemoveOptions {
  json?: boolean
  target?: string
  match?: string
}

export function registerMemoryRemoveCommand(parent: Command): void {
  parent
    .command('remove')
    .description('Remove an entry by substring match from a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--match <text>', 'Substring to locate the entry to remove')
    .action(async (options: RemoveOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory remove: cannot determine agent name\n')
          process.exit(1)
        }

        if (!options.target) {
          process.stderr.write('self memory remove: --target is required\n')
          process.exit(1)
        }
        validateTarget(options.target)

        if (!options.match) {
          process.stderr.write('self memory remove: --match is required\n')
          process.exit(1)
        }

        const store = new MemoryStore({
          agentName: ctx.agentName,
          agentsRoot: ctx.agentsRoot,
        })

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
          process.stderr.write(`self memory remove: ${output.error}\n`)
        }
        process.exit(1)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory remove: ${message}\n`)
        process.exit(1)
      }
    })
}

function validateTarget(value: string): asserts value is MemoryTargetName {
  if (value !== 'memory' && value !== 'user' && value !== 'persona') {
    process.stderr.write(
      `self memory remove: invalid --target '${value}' (expected: memory, user, persona)\n`
    )
    process.exit(1)
  }
}

function mapRemoveError(result: Extract<StoreResult, { ok: false }>): {
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
