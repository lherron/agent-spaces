/**
 * `asp self memory paths` — list all memory target paths with zone/scope labels.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type MemoryTargetName, resolveMemoryPaths } from 'spaces-runtime'

import { resolveSelfContext } from '../lib.js'

interface PathsOptions {
  json?: boolean
}

const HUMAN_LABELS: Record<MemoryTargetName, string> = {
  memory: 'per-agent, reminder',
  user: 'shared-editable, reminder',
  persona: 'per-agent, prompt (next-session)',
}

export function registerMemoryPathsCommand(parent: Command): void {
  parent
    .command('paths')
    .description('List all memory target paths with zone and scope labels')
    .option('--json', 'Emit machine-readable JSON')
    .action(async (options: PathsOptions) => {
      try {
        const ctx = resolveSelfContext()
        if (!ctx.agentName) {
          process.stderr.write('self memory paths: cannot determine agent name\n')
          process.exit(1)
        }

        const paths = resolveMemoryPaths(ctx.agentName, ctx.agentsRoot)
        const targets: Array<{
          target: string
          path: string
          scope: string
          zone: string
        }> = []

        for (const name of ['memory', 'user', 'persona'] as MemoryTargetName[]) {
          const config = paths[name]
          targets.push({
            target: name,
            path: config.path,
            scope: config.scope,
            zone: config.zone,
          })
        }

        if (options.json) {
          process.stdout.write(`${JSON.stringify({ targets }, null, 2)}\n`)
          return
        }

        const out: string[] = []
        for (const entry of targets) {
          const label = HUMAN_LABELS[entry.target as MemoryTargetName]
          out.push(`  ${entry.target.padEnd(10)} ${entry.path}`)
          out.push(`             ${chalk.gray(label)}`)
        }
        // Ensure human labels are visible in NO_COLOR mode too
        out.push('')
        out.push('memory:  per-agent, reminder')
        out.push('user:    shared-editable, reminder')
        out.push('persona: per-agent, prompt (next-session)')

        process.stdout.write(`${out.join('\n')}\n`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        process.stderr.write(`self memory paths: ${message}\n`)
        process.exit(1)
      }
    })
}
