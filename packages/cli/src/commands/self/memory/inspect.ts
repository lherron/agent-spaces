/**
 * `asp self memory inspect` — show metadata for all memory targets.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { MemoryStore, type MemoryTargetName } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface InspectOptions {
  json?: boolean
}

const HUMAN_LABELS: Record<MemoryTargetName, { scope: string; zone: string }> = {
  memory: { scope: 'per-agent', zone: 'reminder' },
  user: { scope: 'shared-editable', zone: 'reminder' },
  persona: { scope: 'per-agent', zone: 'prompt (next-session)' },
}

export function registerMemoryInspectCommand(parent: Command): void {
  parent
    .command('inspect')
    .description('Show metadata for all memory targets')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options: InspectOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory inspect: cannot determine agent name\n')
          process.exit(1)
        }

        const store = new MemoryStore({
          agentName: ctx.agentName,
          agentsRoot: ctx.agentsRoot,
        })

        const targets: MemoryTargetName[] = ['memory', 'user', 'persona']
        const result: Record<string, unknown> = {}

        for (const target of targets) {
          const info = await store.inspect(target)
          result[target] = {
            path: info.path,
            chars: info.chars,
            capChars: info.capChars,
            bytes: info.bytes,
            entries: info.entries,
            lastWrite: info.lastWrite,
            scope: info.scope,
            zone: info.zone,
          }
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
          return
        }

        renderHuman(result, ctx.agentName)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory inspect: ${message}\n`)
        process.exit(1)
      }
    })
}

function renderHuman(result: Record<string, unknown>, agentName: string): void {
  const out: string[] = []
  out.push(chalk.bold(`asp self memory inspect — ${agentName}`))
  out.push('')

  for (const [target, raw] of Object.entries(result)) {
    const info = raw as {
      path: string
      chars: number
      capChars: number
      bytes: number
      entries: number
      lastWrite: string | null
      scope: string
      zone: string
    }
    const label = HUMAN_LABELS[target as MemoryTargetName]
    const fileName = info.path.split('/').pop()
    out.push(`  ${chalk.bold(target)} (${fileName}) — ${label.scope}, ${label.zone}`)
    out.push(
      `    chars: ${info.chars}/${info.capChars}  bytes: ${info.bytes}  entries: ${info.entries}  last: ${info.lastWrite ?? '(never)'}`
    )
    out.push(`    path: ${chalk.gray(info.path)}`)
    out.push('')
  }

  // Labels
  out.push(chalk.gray('Labels:'))
  out.push(chalk.gray('  USER.md → shared-editable'))
  out.push(chalk.gray('  SOUL.md → prompt (next-session)'))

  process.stdout.write(`${out.join('\n')}\n`)
}
