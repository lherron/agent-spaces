import { readFileSync } from 'node:fs'
import type { Command } from 'commander'

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function attachJsonOption(cmd: Command): Command {
  return cmd.option('--json', 'emit JSON output')
}

// Overloads keep the element type honest: omitting `parse` forces `T = string`
// (the raw Commander value), while supplying a parser narrows to its return type.
// This avoids the unsound `value as T` cast for non-string `T` with no parser.
export function repeatable(): (value: string, prev: string[] | undefined) => string[]
export function repeatable<T>(
  parse: (raw: string) => T
): (value: string, prev: T[] | undefined) => T[]
export function repeatable<T>(
  parse?: (raw: string) => T
): (value: string, prev: T[] | undefined) => T[] {
  return (value, prev) => [...(prev ?? []), parse ? parse(value) : (value as unknown as T)]
}

const DURATION_UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
}
const DURATION_RE = new RegExp(`^(\\d+)(${Object.keys(DURATION_UNIT_MS).join('|')})$`)

export function parseDuration(input: string): number {
  const match = input.match(DURATION_RE)
  if (!match || !match[1] || !match[2]) {
    throw new CliUsageError(`invalid duration: ${input} (expected e.g. 30s, 5m, 1h)`)
  }

  // The unit is constrained by the regex alternation above, so the lookup is always defined.
  const multiplier = DURATION_UNIT_MS[match[2]] as number
  return Number.parseInt(match[1], 10) * multiplier
}

export function parseIntegerValue(flag: string, raw: string, options: { min: number }): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < options.min) {
    throw new CliUsageError(`${flag} must be an integer >= ${options.min}`)
  }
  return value
}

// The positional value that signals "read the body from stdin", and the path the
// stdin read is routed to. Behaviour is identical to the inline literals these
// replace — `'-'` still means stdin, still read from `/dev/stdin`.
const STDIN_SENTINEL = '-'
const STDIN_PATH = '/dev/stdin'

export function consumeBody(
  opts: {
    positional?: string | undefined
    file?: string | undefined
  },
  deps: { readFile?: (path: string, encoding: 'utf8') => string } = {}
): string | undefined {
  const { readFile = readFileSync } = deps

  if (opts.file) {
    return readBody(readFile, opts.file, `--file ${opts.file}`)
  }

  if (opts.positional === STDIN_SENTINEL) {
    return readBody(readFile, STDIN_PATH, 'stdin')
  }

  return opts.positional
}

// A bad/unreadable input path is a usage problem, not an internal fault: wrap the
// raw I/O error as a `CliUsageError` so `exitWithError` reports it with exit code
// 2 (usage) instead of 1 (internal), matching the other input validators. This
// rethrows with a clearer message — it does not swallow the failure.
function readBody(
  readFile: (path: string, encoding: 'utf8') => string,
  path: string,
  label: string
): string {
  try {
    return readFile(path, 'utf8')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new CliUsageError(`cannot read ${label}: ${detail}`)
  }
}

const EXIT_CODE_USAGE = 2
const EXIT_CODE_INTERNAL = 1

// Renders the stderr line for an error. Kept separate from `exitWithError` so
// the formatting (JSON envelope vs. `bin: message`) is decoupled from the
// exit-code / write / exit orchestration. Behaviour is identical to the inline
// branches it replaces.
function formatErrorLine(
  message: string,
  usage: boolean,
  opts: { json?: boolean; binName: string }
): string {
  if (opts.json) {
    return `${JSON.stringify({ error: { message, usage } })}\n`
  }
  return `${opts.binName}: ${message}\n`
}

export function exitWithError(
  err: unknown,
  opts: { json?: boolean; binName: string },
  deps: {
    write?: (chunk: string) => void
    exit?: (code: number) => never
  } = {}
): never {
  const { write = (chunk: string) => void process.stderr.write(chunk), exit = process.exit } = deps

  const message = err instanceof Error ? err.message : String(err)
  const usage = err instanceof CliUsageError
  const exitCode = usage ? EXIT_CODE_USAGE : EXIT_CODE_INTERNAL

  write(formatErrorLine(message, usage, opts))

  return exit(exitCode)
}
