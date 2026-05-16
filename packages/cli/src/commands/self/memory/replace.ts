/**
 * `asp self memory replace` — replace a substring-matched entry in a memory target.
 */

import type { Command } from 'commander'

import { MemoryStore, type MemoryTargetName, type StoreResult } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface ReplaceOptions {
  json?: boolean
  target?: string
  match?: string
  content?: string
}

export function registerMemoryReplaceCommand(parent: Command): void {
  parent
    .command('replace')
    .description('Replace a substring-matched entry in a memory target')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target: memory|user|persona')
    .option('--match <text>', 'Substring to locate the entry')
    .option('--content <text>', 'Replacement content')
    .action(async (options: ReplaceOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory replace: cannot determine agent name\n')
          process.exit(1)
        }

        if (!options.target) {
          process.stderr.write('self memory replace: --target is required\n')
          process.exit(1)
        }
        validateTarget(options.target)

        if (!options.match) {
          process.stderr.write('self memory replace: --match is required\n')
          process.exit(1)
        }
        if (!options.content) {
          process.stderr.write('self memory replace: --content is required\n')
          process.exit(1)
        }

        const store = new MemoryStore({
          agentName: ctx.agentName,
          agentsRoot: ctx.agentsRoot,
        })

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
        const exitCode = mapErrorToExitCode(result)

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`self memory replace: ${output.error}\n`)
        }
        process.exit(exitCode)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory replace: ${message}\n`)
        process.exit(1)
      }
    })
}

function validateTarget(value: string): asserts value is MemoryTargetName {
  if (value !== 'memory' && value !== 'user' && value !== 'persona') {
    process.stderr.write(
      `self memory replace: invalid --target '${value}' (expected: memory, user, persona)\n`
    )
    process.exit(1)
  }
}

function mapErrorToExitCode(result: Extract<StoreResult, { ok: false }>): number {
  if ('error' in result) {
    if (result.error === 'ambiguous_match' || result.error === 'not_found') return 1
    if (result.error === 'cap_exceeded') return 3
    if (result.error === 'delimiter_in_content') return 4
  }
  if ('category' in result) return 2
  return 1
}

function mapReplaceError(result: Extract<StoreResult, { ok: false }>): {
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
