/**
 * `asp self inspect` — zero-arg overview of the current agent's runtime.
 *
 * Reads HRC_LAUNCH_FILE + environment and emits identity, paths, prompt mode,
 * and content sizes. Defaults to a human-readable report; --json emits the
 * full SelfContext plus derived counts.
 */

import chalk from 'chalk'
import type { Command } from 'commander'

import { byteCount, charCount, resolveSelfContext } from './lib.js'

interface InspectOptions {
  json?: boolean
  target?: string
  launchFile?: string
}

export function registerSelfInspectCommand(self: Command): void {
  self
    .command('inspect')
    .description("Show a zero-arg overview of this agent's runtime launch")
    .option('--json', 'Emit machine-readable JSON')
    .option('--target <name>', 'Override inferred agent slug')
    .option('--launch-file <path>', 'Override HRC_LAUNCH_FILE')
    .action(async (options: InspectOptions) => {
      try {
        const ctx = resolveSelfContext({
          ...(options.target ? { target: options.target } : {}),
          ...(options.launchFile ? { launchFile: options.launchFile } : {}),
        })

        const systemPromptChars = charCount(ctx.systemPrompt?.content)
        const systemPromptBytes = byteCount(ctx.systemPrompt?.content)
        const primingChars = charCount(ctx.primingPrompt)

        if (options.json) {
          process.stdout.write(
            `${JSON.stringify(
              {
                ...ctx,
                derived: {
                  systemPromptChars,
                  systemPromptBytes,
                  primingPromptChars: primingChars,
                  argvLength: ctx.launch?.argv?.length ?? 0,
                },
              },
              null,
              2
            )}\n`
          )
          return
        }

        renderHuman(ctx, { systemPromptChars, systemPromptBytes, primingChars })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        process.stderr.write(`self inspect: ${message}\n`)
        process.exit(1)
      }
    })
}

interface DerivedCounts {
  systemPromptChars: number
  systemPromptBytes: number
  primingChars: number
}

function renderHuman(ctx: ReturnType<typeof resolveSelfContext>, counts: DerivedCounts): void {
  const bold = (s: string): string => chalk.bold(s)
  const dim = (s: string): string => chalk.gray(s)
  const warn = (s: string): string => chalk.yellow(s)

  const out: string[] = []
  out.push(bold(`asp self inspect — ${ctx.agentName ?? warn('(unknown agent)')}`))
  out.push('')

  out.push(bold('identity'))
  out.push(dim(`  agent:       ${ctx.agentName ?? '(none)'}`))
  out.push(dim(`  project:     ${ctx.projectId ?? '(none)'}`))
  out.push(dim(`  session-ref: ${ctx.sessionRef ?? '(none)'}`))
  out.push(dim(`  scope-ref:   ${ctx.scopeRef ?? '(none)'}`))
  out.push(dim(`  lane:        ${ctx.laneRef ?? '(none)'}`))
  out.push('')

  out.push(bold('runtime'))
  out.push(dim(`  harness:     ${ctx.harness ?? '(unknown)'}`))
  out.push(dim(`  provider:    ${ctx.provider ?? '(unknown)'}`))
  out.push(dim(`  launch:      ${ctx.launchId ?? '(none)'}`))
  out.push(dim(`  runtime:     ${ctx.runtimeId ?? '(none)'}`))
  out.push(dim(`  run:         ${ctx.runId ?? '(none)'}`))
  out.push(dim(`  host:        ${ctx.hostSessionId ?? '(none)'}`))
  out.push(dim(`  generation:  ${ctx.generation ?? '(none)'}`))
  out.push('')

  out.push(bold('paths'))
  out.push(dim(`  cwd:         ${ctx.cwd}`))
  out.push(dim(`  asp-home:    ${ctx.aspHome}`))
  out.push(dim(`  agents-root: ${ctx.agentsRoot}`))
  out.push(dim(`  agent-root:  ${ctx.agentRoot ?? '(none)'}`))
  out.push(dim(`  bundle-root: ${ctx.bundleRoot ?? '(none)'}`))
  out.push(dim(`  launch-file: ${ctx.launchFilePath ?? '(none)'}`))
  if (ctx.launchReadError) {
    out.push(warn(`  launch-read-error: ${ctx.launchReadError}`))
  }
  out.push('')

  out.push(bold('prompt'))
  if (ctx.systemPrompt) {
    out.push(
      dim(
        `  system:      mode=${ctx.systemPrompt.mode} chars=${counts.systemPromptChars} bytes=${counts.systemPromptBytes}`
      )
    )
  } else {
    out.push(dim('  system:      (none extracted from argv)'))
  }
  if (ctx.primingPrompt) {
    out.push(dim(`  priming:     chars=${counts.primingChars}`))
  } else {
    out.push(dim('  priming:     (none)'))
  }
  out.push('')

  out.push(dim('Use `asp self paths` to see every editable and derived path.'))
  out.push(dim('Use `asp self prompt system|reminder|priming` for content.'))

  process.stdout.write(`${out.join('\n')}\n`)
}
