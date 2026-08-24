/**
 * `asp self memory read` — read raw content from memory targets.
 */

import type { Command } from 'commander'

import type { MemoryTargetName } from 'spaces-runtime'

import { validateTarget, withMemoryStore } from './lib.js'

interface ReadOptions {
  json?: boolean
  target?: string
}

const ALL_TARGETS: MemoryTargetName[] = ['memory', 'user', 'persona']

const COMMAND_NAME = 'self memory read'

export function registerMemoryReadCommand(parent: Command): void {
  parent
    .command('read')
    .description('Read raw content from memory targets')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Read a specific target: memory|user|persona')
    .action(async (options: ReadOptions) => {
      await withMemoryStore(COMMAND_NAME, async (store) => {
        if (options.target) {
          validateTarget(COMMAND_NAME, options.target)
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
      })
    })
}
