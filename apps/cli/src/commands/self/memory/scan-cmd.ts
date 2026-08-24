/**
 * `asp self memory scan` — check content for scanner violations.
 *
 * Accepts content as positional arg or stdin (with `-`).
 */

import { readFileSync } from 'node:fs'

import type { Command } from 'commander'

import { scan } from 'spaces-runtime'

import { withMemoryCommand } from './lib.js'

interface ScanOptions {
  json?: boolean
}

const COMMAND_NAME = 'self memory scan'

export function registerMemoryScanCommand(parent: Command): void {
  parent
    .command('scan [content...]')
    .description('Check content for scanner violations')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (contentArgs: string[], options: ScanOptions) => {
      await withMemoryCommand(COMMAND_NAME, async () => {
        let content: string

        if (contentArgs.length === 1 && contentArgs[0] === '-') {
          // Read from stdin
          content = readFileSync(0, 'utf8')
        } else if (contentArgs.length > 0) {
          content = contentArgs.join(' ')
        } else {
          process.stderr.write(`${COMMAND_NAME}: content argument required\n`)
          process.exit(1)
          return
        }

        const result = scan(content)

        if (result.ok) {
          if (options.json) {
            process.stdout.write(`${JSON.stringify({ ok: true })}\n`)
          } else {
            process.stdout.write('ok\n')
          }
          return
        }

        // Scanner flagged the content
        const output = {
          ok: false,
          category: result.category.replace('_', '-'),
          pattern: content,
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
        } else {
          process.stderr.write(`scanner blocked: ${output.category} (${output.pattern})\n`)
        }
        process.exit(2)
      })
    })
}
