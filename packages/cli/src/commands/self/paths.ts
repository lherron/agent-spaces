/**
 * `asp self paths` — list every path that matters to the agent's runtime,
 * classified as editable / shared-editable / derived / ephemeral.
 *
 * This is the bridge from introspection to self-modification: an agent looking
 * to change itself uses this to find the source file, then edits it with its
 * normal Edit tool.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { type PathKind, enumeratePaths, resolveSelfContext } from './lib.js'

interface PathsOptions {
  json?: boolean
  target?: string
  launchFile?: string
  kind?: string
  existing?: boolean
}

export function registerSelfPathsCommand(self: Command): void {
  self
    .command('paths')
    .description('List every path in the agent runtime, classified editable vs derived')
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Override inferred agent slug')
    .option('--launch-file <path>', 'Override HRC_LAUNCH_FILE')
    .option('--kind <kind>', 'Filter by kind: editable | shared-editable | derived | ephemeral')
    .option('--existing', 'Only show paths that currently exist')
    .action(async (options: PathsOptions) => {
      try {
        const ctx = resolveSelfContext({
          ...(options.target ? { target: options.target } : {}),
          ...(options.launchFile ? { launchFile: options.launchFile } : {}),
        })
        let entries = enumeratePaths(ctx)

        if (options.kind) {
          if (!isPathKind(options.kind)) {
            process.stderr.write(
              `self paths: invalid --kind '${options.kind}' (expected: editable, shared-editable, derived, ephemeral)\n`
            )
            process.exit(2)
          }
          const wanted = options.kind
          entries = entries.filter((e) => e.kind === wanted)
        }
        if (options.existing) {
          entries = entries.filter((e) => e.exists)
        }

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                agent: ctx.agentName,
                agentRoot: ctx.agentRoot,
                agentsRoot: ctx.agentsRoot,
                bundleRoot: ctx.bundleRoot,
                entries,
              },
              null,
              2
            )}\n`
          )
          return
        }

        renderHuman(entries, ctx.agentName)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`self paths: ${message}\n`)
        process.exit(1)
      }
    })
}

function isPathKind(value: string): value is PathKind {
  return (
    value === 'editable' ||
    value === 'shared-editable' ||
    value === 'derived' ||
    value === 'ephemeral'
  )
}

function kindTag(kind: PathKind): string {
  switch (kind) {
    case 'editable':
      return chalk.green('EDIT')
    case 'shared-editable':
      return chalk.yellow('SHRD')
    case 'derived':
      return chalk.gray('DRVD')
    case 'ephemeral':
      return chalk.blue('EPHM')
  }
}

function existsMark(exists: boolean): string {
  return exists ? chalk.green('✓') : chalk.gray('·')
}

function renderHuman(entries: ReturnType<typeof enumeratePaths>, agent: string | null): void {
  const out: string[] = []
  out.push(chalk.bold(`asp self paths — ${agent ?? '(unknown agent)'}`))
  out.push('')

  if (entries.length === 0) {
    out.push(chalk.gray('  (no paths matched)'))
    process.stdout.write(`${out.join('\n')}\n`)
    return
  }

  const nameWidth = Math.max(...entries.map((e) => e.name.length))

  for (const entry of entries) {
    out.push(
      `  ${existsMark(entry.exists)} ${kindTag(entry.kind)}  ${entry.name.padEnd(
        nameWidth
      )}  ${chalk.gray(entry.path)}`
    )
    out.push(`              ${chalk.gray(entry.description)}`)
  }
  out.push('')
  out.push(
    chalk.gray(
      'Legend: EDIT=agent-local source · SHRD=shared (affects all agents) · DRVD=bundle output (do not edit) · EPHM=runtime state'
    )
  )

  process.stdout.write(`${out.join('\n')}\n`)
}
