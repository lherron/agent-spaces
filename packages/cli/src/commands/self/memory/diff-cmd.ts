/**
 * `asp self memory diff` — show unified diff between bundled snapshot and fresh recompute.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Command } from 'commander'

import { resolveContextTemplateDetailed } from 'spaces-runtime'

import { resolveSelfContext, resolveSelfTemplateContext } from '../lib.js'

interface DiffOptions {
  json?: boolean
  target?: string
}

export function registerMemoryDiffCommand(parent: Command): void {
  parent
    .command('diff')
    .description('Show unified diff between bundled snapshot and fresh recompute')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Target filter (memory|user only — persona is rejected)')
    .action(async (options: DiffOptions) => {
      try {
        // Reject persona target
        if (options.target === 'persona') {
          process.stderr.write(
            'self memory diff: --target persona is not supported (persona is prompt-zone, not reminder-zone)\n'
          )
          process.exit(2)
        }

        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory diff: cannot determine agent name\n')
          process.exit(1)
        }

        const bundleRoot = ctx.bundleRoot
        const reminderPath = bundleRoot ? join(bundleRoot, 'session-reminder.md') : null
        const snapshot =
          reminderPath && existsSync(reminderPath) ? readFileSync(reminderPath, 'utf8') : ''

        // Recompute
        const templateCtx = resolveSelfTemplateContext(ctx)
        let recompute = ''
        if (templateCtx.template) {
          const resolved = await resolveContextTemplateDetailed(
            templateCtx.template,
            templateCtx.resolverContext,
            { includePrompt: false }
          )
          recompute = resolved.reminder ?? ''
        }

        const diff = unifiedDiff(snapshot, recompute)

        if (options.json) {
          process.stdout.write(`${JSON.stringify({ snapshot, recompute, diff }, null, 2)}\n`)
        } else {
          process.stdout.write(diff)
          if (!diff.endsWith('\n')) process.stdout.write('\n')
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory diff: ${message}\n`)
        process.exit(1)
      }
    })
}

function unifiedDiff(a: string, b: string): string {
  const aLines = a.split('\n')
  const bLines = b.split('\n')
  const out: string[] = []

  out.push('--- snapshot')
  out.push('+++ recompute')

  // Simple line-by-line diff
  const maxLen = Math.max(aLines.length, bLines.length)
  const hunks: Array<{ start: number; aLines: string[]; bLines: string[] }> = []
  let currentHunk: { start: number; aLines: string[]; bLines: string[] } | null = null

  for (let i = 0; i < maxLen; i++) {
    const aLine = i < aLines.length ? aLines[i] : undefined
    const bLine = i < bLines.length ? bLines[i] : undefined

    if (aLine !== bLine) {
      if (!currentHunk) {
        currentHunk = { start: i, aLines: [], bLines: [] }
      }
      if (aLine !== undefined) currentHunk.aLines.push(aLine)
      if (bLine !== undefined) currentHunk.bLines.push(bLine)
    } else {
      if (currentHunk) {
        hunks.push(currentHunk)
        currentHunk = null
      }
    }
  }
  if (currentHunk) hunks.push(currentHunk)

  for (const hunk of hunks) {
    out.push(`@@ -${hunk.start + 1} +${hunk.start + 1} @@`)
    for (const line of hunk.aLines) {
      out.push(`-${line}`)
    }
    for (const line of hunk.bLines) {
      out.push(`+${line}`)
    }
  }

  return out.join('\n')
}
