/**
 * `asp self memory snapshot` — read the current bundle session-reminder.md,
 * or fall back to a fresh resolver invocation.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { resolveContextTemplateDetailed } from 'spaces-runtime'

import { resolveSelfContext, resolveSelfTemplateContext } from '../lib.js'

interface SnapshotOptions {
  json?: boolean
  target?: string
  bundleRoot?: string
}

export function registerMemorySnapshotCommand(parent: Command): void {
  parent
    .command('snapshot')
    .description('Read the current session reminder snapshot')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target filter (memory|user only — persona is rejected)')
    .option('--bundle-root <path>', 'Override bundle root for testing')
    .action(async (options: SnapshotOptions) => {
      try {
        // Reject persona target
        if (options.target === 'persona') {
          process.stderr.write(
            'self memory snapshot: --target persona is not supported (persona is prompt-zone, not reminder-zone)\n'
          )
          process.exit(2)
        }

        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory snapshot: cannot determine agent name\n')
          process.exit(1)
        }

        const bundleRoot = options.bundleRoot ?? ctx.bundleRoot
        const reminderPath = bundleRoot ? join(bundleRoot, 'session-reminder.md') : null

        if (reminderPath && existsSync(reminderPath)) {
          const content = readFileSync(reminderPath, 'utf8')
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ source: 'bundle/session-reminder.md', content }, null, 2)}\n`
            )
          } else {
            process.stdout.write(`source: bundle/session-reminder.md\n\n${content}\n`)
          }
          return
        }

        // Fallback: resolve from template
        const templateCtx = resolveSelfTemplateContext(ctx)
        if (templateCtx.template) {
          const resolved = await resolveContextTemplateDetailed(
            templateCtx.template,
            templateCtx.resolverContext,
            { includePrompt: false }
          )
          const content = resolved.reminder ?? ''
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ source: 'resolver-fallback', content }, null, 2)}\n`
            )
          } else {
            process.stdout.write(`source: resolver-fallback\n\n${content}\n`)
          }
        } else {
          if (options.json) {
            process.stdout.write(
              `${JSON.stringify({ source: 'resolver-fallback', content: '' }, null, 2)}\n`
            )
          } else {
            process.stdout.write('source: resolver-fallback\n\n')
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory snapshot: ${message}\n`)
        process.exit(1)
      }
    })
}
