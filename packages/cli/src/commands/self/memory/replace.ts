/**
 * `asp self memory replace` — replace a substring-matched entry in a memory target.
 */

import type { Command } from 'commander'

import type { MemoryTargetName } from 'spaces-runtime'

import {
  type StoreFailure,
  mapWriteFailureToExitCode,
  validateTarget,
  withMemoryStore,
} from './lib.js'

interface ReplaceOptions {
  json?: boolean
  target?: string
  match?: string
  content?: string
}

const COMMAND_NAME = 'self memory replace'

export function registerMemoryReplaceCommand(parent: Command): void {
  parent
    .command('replace')
    .description('Replace a substring-matched entry in a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--match <text>', 'Substring to locate the entry')
    .option('--content <text>', 'Replacement content')
    .action(async (options: ReplaceOptions) => {
      await withMemoryStore(COMMAND_NAME, async (store) => {
        if (!options.target) {
          process.stderr.write(`${COMMAND_NAME}: --target is required\n`)
          process.exit(1)
        }
        validateTarget(COMMAND_NAME, options.target)

        if (!options.match) {
          process.stderr.write(`${COMMAND_NAME}: --match is required\n`)
          process.exit(1)
        }
        if (!options.content) {
          process.stderr.write(`${COMMAND_NAME}: --content is required\n`)
          process.exit(1)
        }

        const result = await store.replace({
          target: options.target as MemoryTargetName,
          old: options.match,
          content: options.content,
        })

        if (result.ok) {
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
          } else {
            process.stdout.write(`Replaced entry in ${options.target}\n`)
          }
          return
        }

        // Handle failures
        const output = mapReplaceError(result)
        const exitCode = mapWriteFailureToExitCode(result)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`${COMMAND_NAME}: ${output.error}\n`)
        }
        process.exit(exitCode)
      })
    })
}

function mapReplaceError(result: StoreFailure): {
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
  if ('error' in result && result.error === 'cap_exceeded') {
    return {
      ok: false,
      error: 'cap_exceeded',
      chars: result.chars,
      capChars: result.capChars,
      bytes: result.bytes,
    }
  }
  if ('category' in result) {
    return {
      ok: false,
      error: 'scanner_blocked',
      category: result.category,
      pattern: result.pattern,
    }
  }
  return { ok: false, error: 'unknown' }
}
