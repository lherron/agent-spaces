import { readFileSync } from 'node:fs'
import type { Command } from 'commander'

export type BuildDeps<D> = () => D

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CliUsageError'
  }
}

export function attachJsonOption(cmd: Command): Command {
  return cmd.option('--json', 'emit JSON output')
}

export function attachServerOption(cmd: Command, defaultUrl?: string): Command {
  if (defaultUrl === undefined) {
    return cmd.option('--server <url>', 'server URL')
  }
  return cmd.option('--server <url>', 'server URL', defaultUrl)
}

export function attachActorOption(cmd: Command): Command {
  return cmd.option('--actor <agentId>', 'actor agent id')
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

export function withDeps<D, R, Opts = Record<string, unknown>>(
  handler: (opts: Opts, args: string[], deps: D) => Promise<R>,
  buildDeps: BuildDeps<D>
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    // Commander invokes action handlers with the positional arguments first and
    // the `Command` instance as the final argument, so `args.at(-1)` is the
    // `Command` and the preceding entries are the positionals.
    const command = args.at(-1) as Command | undefined
    const positionals = args.slice(0, -1) as string[]
    const opts = (command?.opts() ?? {}) as Opts
    await handler(opts, positionals, buildDeps())
  }
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

// User-defined type guard keeps the runtime check and the static type in
// lock-step: narrowing here is what lets the caller return `value` without an
// `as` cast, so weakening this guard would fail to compile rather than silently
// lie about the return type.
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJsonObject(flag: string, raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CliUsageError(`${flag} must be valid JSON`)
  }

  if (!isPlainObject(value)) {
    throw new CliUsageError(`${flag} must be a JSON object`)
  }

  return value
}

export function parseCommaList(flag: string, raw: string): string[] {
  const values = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0)

  if (values.length === 0) {
    throw new CliUsageError(`${flag} requires at least one value`)
  }

  return values
}

export function parseIntegerValue(flag: string, raw: string, options: { min: number }): number {
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < options.min) {
    throw new CliUsageError(`${flag} must be an integer >= ${options.min}`)
  }
  return value
}

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

  if (opts.positional === '-') {
    return readBody(readFile, '/dev/stdin', 'stdin')
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

  if (opts.json) {
    write(`${JSON.stringify({ error: { message, usage } })}\n`)
  } else {
    write(`${opts.binName}: ${message}\n`)
  }

  return exit(exitCode)
}
