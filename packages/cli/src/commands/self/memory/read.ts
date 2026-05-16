/**
 * `asp self memory read` — read raw content from memory targets.
 */

import type { Command } from 'commander'

import { MemoryStore, type MemoryTargetName } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface ReadOptions {
  json?: boolean
  target?: string
}

const ALL_TARGETS: MemoryTargetName[] = ['memory', 'user', 'persona']

export function registerMemoryReadCommand(parent: Command): void {
  parent
    .command('read')
    .description('Read raw content from memory targets')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Read a specific target: memory|user|persona')
    .action(async (options: ReadOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory read: cannot determine agent name\n')
          process.exit(1)
        }

        const store = new MemoryStore({
          agentName: ctx.agentName,
          agentsRoot: ctx.agentsRoot,
        })

        if (options.target) {
          validateTarget(options.target)
          const content = await store.read(options.target as MemoryTargetName)

          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ target: options.target, content }, null, 2)}\n`
            )
          } else {
            process.stdout.write(content)
          }
          return
        }

        // No target specified: output all three with headers
        const results: Array<{ target: string; content: string }> = []
        for (const target of ALL_TARGETS) {
          const content = await store.read(target)
          results.push({ target, content })
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(results, null, 2)}\n`)
          return
        }

        for (const entry of results) {
          process.stdout.write(`target: ${entry.target}\n`)
          process.stdout.write(`${entry.content}\n`)
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory read: ${message}\n`)
        process.exit(1)
      }
    })
}

function validateTarget(value: string): asserts value is MemoryTargetName {
  if (value !== 'memory' && value !== 'user' && value !== 'persona') {
    process.stderr.write(
      `self memory read: invalid --target '${value}' (expected: memory, user, persona)\n`
    )
    process.exit(1)
  }
}
