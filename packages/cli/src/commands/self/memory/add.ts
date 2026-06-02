/**
 * `asp self memory add` — append a new entry to a memory target.
 */

import type { Command } from 'commander'

import type { MemoryTargetName } from 'spaces-runtime'

import {
  type StoreFailure,
  mapWriteFailureToExitCode,
  validateTarget,
  withMemoryStore,
} from './lib.js'

interface AddOptions {
  json?: boolean
  target?: string
  content?: string
}

const COMMAND_NAME = 'self memory add'

export function registerMemoryAddCommand(parent: Command): void {
  parent
    .command('add')
    .description('Append a new entry to a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--content <text>', 'Content to add')
    .action(async (options: AddOptions) => {
      await withMemoryStore(COMMAND_NAME, async (store) => {
        if (!options.target) {
          process.stderr.write(`${COMMAND_NAME}: --target is required\n`)
          process.exit(1)
        }
        validateTarget(COMMAND_NAME, options.target)

        if (!options.content) {
          process.stderr.write(`${COMMAND_NAME}: --content is required\n`)
          process.exit(1)
        }

        const result = await store.add({
          target: options.target as MemoryTargetName,
          content: options.content,
        })

        if (result.ok) {
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
          } else {
            process.stdout.write(`Added entry to ${options.target}\n`)
          }
          return
        }

        // Handle failures
        const exitCode = mapWriteFailureToExitCode(result)
        const output = mapStoreResultToOutput(result, options.content)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`${COMMAND_NAME}: ${output.error}\n`)
        }
        process.exit(exitCode)
      })
    })
}

function mapStoreResultToOutput(
  result: StoreFailure,
  content: string
): { ok: false; error: string; [key: string]: unknown } {
  // Scanner blocked
  if ('category' in result) {
    return {
      ok: false,
      error: 'scanner_blocked',
      category: result.category.replace('_', '-'),
      pattern: content,
    }
  }
  // Cap exceeded
  if ('error' in result && result.error === 'cap_exceeded') {
    return {
      ok: false,
      error: 'cap_exceeded',
      chars: result.chars,
      capChars: result.capChars,
      bytes: result.bytes,
    }
  }
  // Delimiter in content
  if ('error' in result && result.error === 'delimiter_in_content') {
    return {
      ok: false,
      error: 'delimiter_in_content',
    }
  }
  return { ok: false, error: 'unknown' }
}
