/**
 * Describe command - Summarize hooks, skills, tools, and lint warnings for targets.
 *
 * WHY: Provides a lightweight view of what a target would load without running it.
 */

import { join } from 'node:path'

import chalk from 'chalk'
import type { Command } from 'commander'

import { createAgentSpacesClient } from 'agent-spaces'
import { TARGETS_FILENAME, formatWarnings, readTargetsToml } from 'spaces-config'
import type { LintWarning } from 'spaces-config'

import { type CommonOptions, getProjectContext, handleCliError } from '../helpers.js'

interface DescribeOptions extends CommonOptions {
  harness?: string | undefined
  model?: string | undefined
}

function formatList(items: string[]): string {
  if (items.length === 0) return chalk.gray('(none)')
  return items.join(', ')
}

function formatLintWarnings(warnings: LintWarning[]): string {
  if (warnings.length === 0) {
    return chalk.green('  none')
  }
  const formatted = formatWarnings(warnings)
  return formatted
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/**
 * Register the describe command.
 */
export function registerDescribeCommand(program: Command): void {
  program
    .command('describe')
    .description('Describe hooks, skills, tools, and lint warnings for targets')
    .argument('[target]', 'Specific target to describe (default: all)')
    .option('--json', 'Output as JSON')
    .option('--harness <id>', 'Harness to use when materializing (default: agent-sdk)')
    .option('--model <id>', 'Model to use (harness-specific)')
    .option('--project <path>', 'Project directory (default: auto-detect)')
    .option('--registry <path>', 'Registry path override')
    .option('--asp-home <path>', 'ASP_HOME override')
    .action(async (target: string | undefined, options: DescribeOptions) => {
      try {
        const ctx = await getProjectContext(options)
        const manifest = await readTargetsToml(join(ctx.projectPath, TARGETS_FILENAME))
        const targetNames = target ? [target] : Object.keys(manifest.targets)

        if (targetNames.length === 0) {
          console.log(chalk.yellow('No targets found'))
          return
        }

        for (const name of targetNames) {
          if (!(name in manifest.targets)) {
            throw new Error(`Target not found: ${name}`)
          }
        }

        const client = createAgentSpacesClient()
        const results: Record<string, unknown> = {}

        for (const name of targetNames) {
          const describeResult = await client.describe({
            aspHome: ctx.aspHome,
            spec: { target: { targetName: name, targetDir: ctx.projectPath } },
            registryPath: ctx.registryPath,
            ...(options.harness ? { harness: options.harness } : {}),
            ...(options.model ? { model: options.model } : {}),
            runLint: true,
          })
          results[name] = describeResult
        }

        if (options.json) {
          console.log(JSON.stringify({ targets: results }, null, 2))
          return
        }

        for (const name of targetNames) {
          const describeResult = results[name] as {
            hooks: string[]
            skills: string[]
            tools: string[]
            lintWarnings?: LintWarning[] | undefined
          }

          console.log(chalk.blue(`Target: ${name}`))
          console.log(`hooks: ${formatList(describeResult.hooks ?? [])}`)
          console.log(`skills: ${formatList(describeResult.skills ?? [])}`)
          console.log(`tools: ${formatList(describeResult.tools ?? [])}`)
          if (describeResult.lintWarnings) {
            console.log('lint warnings:')
            console.log(formatLintWarnings(describeResult.lintWarnings))
          }
          console.log('')
        }
      } catch (error) {
        handleCliError(error)
      }
    })
}
