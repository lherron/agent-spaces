/**
 * `asp self memory add` — append a new entry to a memory target.
 */

import type { Command } from 'commander'

import { MemoryStore, type MemoryTargetName, type StoreResult } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface AddOptions {
  json?: boolean
  target?: string
  content?: string
}

export function registerMemoryAddCommand(parent: Command): void {
  parent
    .command('add')
    .description('Append a new entry to a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--content <text>', 'Content to add')
    .action(async (options: AddOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory add: cannot determine agent name\n')
          process.exit(1)
        }

        if (!options.target) {
          process.stderr.write('self memory add: --target is required\n')
          process.exit(1)
        }
        validateTarget(options.target)

        if (!options.content) {
          process.stderr.write('self memory add: --content is required\n')
          process.exit(1)
        }

        const store = new MemoryStore({
          agentName: ctx.agentName,
          agentsRoot: ctx.agentsRoot,
        })

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
        const exitCode = mapErrorToExitCode(result)
        const output = mapStoreResultToOutput(result, options.content)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`self memory add: ${output.error}\n`)
        }
        process.exit(exitCode)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory add: ${message}\n`)
        process.exit(1)
      }
    })
}

function validateTarget(value: string): asserts value is MemoryTargetName {
  if (value !== 'memory' && value !== 'user' && value !== 'persona') {
    process.stderr.write(
      `self memory add: invalid --target '${value}' (expected: memory, user, persona)\n`
    )
    process.exit(1)
  }
}

function mapErrorToExitCode(result: Extract<StoreResult, { ok: false }>): number {
  if ('error' in result) {
    if (result.error === 'cap_exceeded') return 3
    if (result.error === 'delimiter_in_content') return 4
  }
  if ('category' in result) return 2
  return 1
}

function mapStoreResultToOutput(
  result: Extract<StoreResult, { ok: false }>,
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
