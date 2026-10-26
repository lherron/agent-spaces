/**
 * One usage row per asp process (`asp-cli-<day>.ndjson`, kind `invocation`,
 * T-11824): which subcommands and flags are used, how each run ended, and
 * whether it compiled in-process, through aspd, or not at all.
 *
 * Only names are recorded: the subcommand path (never positionals), the flag
 * names the command tree declares (never values), and ASP_PROJECT / the agent
 * id from the environment. Never cwd, argv values, prompts or paths. Recording
 * is silent: the CLI has no log, so a metrics failure shows nowhere.
 */
import type { Command, Option } from 'commander'
import {
  configureUsageMetricsHost,
  usageCompileMode,
  usageMetrics,
} from 'spaces-config/usage-metrics'

const HELP_FLAGS = new Set(['-h', '--help'])

export interface InvocationRecorder {
  setProgram(program: Command): void
  /** Commander displayed help (including a bare command group). */
  markHelp(): void
}

type Parsed = { cmd: string; flags: string[]; unknownFlags: number; help: boolean }

function optionFor(command: Command, token: string): Option | undefined {
  const name = token.split('=', 1)[0]
  return command.options.find((option) => option.long === name || option.short === name)
}

function childFor(command: Command, token: string): Command | undefined {
  return command.commands.find((child) => child.name() === token || child.aliases().includes(token))
}

/** Walk argv against the command tree; positionals and values are skipped, never kept. */
export function parseInvocation(argv: readonly string[], root: Command | undefined): Parsed {
  const path: string[] = []
  const flags: string[] = []
  let unknownFlags = 0
  let help = false
  let command = root
  for (let index = 2; index < argv.length; index++) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--') break
    if (token.startsWith('-') && token !== '-') {
      if (HELP_FLAGS.has(token)) {
        help = true
        flags.push(token)
        continue
      }
      const option =
        command === undefined
          ? undefined
          : (optionFor(command, token) ?? (root ? optionFor(root, token) : undefined))
      if (option === undefined) {
        unknownFlags++
        continue
      }
      flags.push(token.split('=', 1)[0] as string)
      if (!token.includes('=') && (option.required || option.optional)) {
        const next = argv[index + 1]
        if (option.required || (next !== undefined && !next.startsWith('-'))) index++
      }
      continue
    }
    const child = command === undefined ? undefined : childFor(command, token)
    if (child) {
      path.push(child.name())
      command = child
    } else if (token === 'help' && path.length === 0 && !help) {
      // `asp help <command>`: the rest of the path names the command asked about.
      help = true
    }
  }
  return { cmd: path.join(' '), flags, unknownFlags, help }
}

/** Install at the asp bin entry, before the program parses. Never throws. */
export function installInvocationRecorder(options: {
  version: string
  argv?: readonly string[]
}): InvocationRecorder {
  const argv = options.argv ?? process.argv
  const startedAt = new Date()
  const started = performance.now()
  let program: Command | undefined
  let helpShown = false
  try {
    configureUsageMetricsHost({ product: `asp/${options.version}` })
    const metrics = usageMetrics('asp-cli')
    metrics.onExit((exit) => {
      const parsed = parseInvocation(argv, program)
      const project = process.env['ASP_PROJECT']?.trim()
      const agent = (process.env['ASP_AGENT_ID'] ?? process.env['AGENTCHAT_ID'])?.trim()
      metrics.record('invocation', {
        ts: startedAt.toISOString(),
        cmd: parsed.cmd,
        flags: parsed.flags,
        ...(parsed.unknownFlags > 0 ? { unknownFlags: parsed.unknownFlags } : {}),
        exitCode: exit.code,
        ...(exit.signal ? { signal: exit.signal } : {}),
        durMs: Math.round((performance.now() - started) * 10) / 10,
        tty: process.stdout.isTTY === true,
        ...(parsed.help || helpShown ? { help: true } : {}),
        compile: usageCompileMode(),
        ...(project ? { project } : {}),
        ...(agent ? { agent } : {}),
      })
    })
  } catch {
    // Metrics are observational; the CLI runs unchanged without them.
  }
  return {
    setProgram(next) {
      program = next
    },
    markHelp() {
      helpShown = true
    },
  }
}
