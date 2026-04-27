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

export function repeatable<T = string>(
  parse?: (raw: string) => T
): (value: string, prev: T[] | undefined) => T[] {
  return (value, prev) => [...(prev ?? []), parse ? parse(value) : (value as T)]
}

export function withDeps<D, R, Opts = Record<string, unknown>>(
  handler: (opts: Opts, args: string[], deps: D) => Promise<R>,
  buildDeps: BuildDeps<D>
): (...args: unknown[]) => Promise<void> {
  return async (...args: unknown[]) => {
    const command = args.at(-1) as Command | undefined
    const positionals = args.slice(0, -1) as string[]
    const opts = (command?.opts() ?? {}) as Opts
    await handler(opts, positionals, buildDeps())
  }
}

export function parseDuration(input: string): number {
  const match = input.match(/^(\d+)(ms|s|m|h)$/)
  if (!match || !match[1] || !match[2]) {
    throw new CliUsageError(`invalid duration: ${input} (expected e.g. 30s, 5m, 1h)`)
  }

  const value = Number.parseInt(match[1], 10)
  switch (match[2]) {
    case 'ms':
      return value
    case 's':
      return value * 1000
    case 'm':
      return value * 60_000
    case 'h':
      return value * 3_600_000
    default:
      throw new CliUsageError(`unknown duration unit: ${match[2]}`)
  }
}

export function parseJsonObject(flag: string, raw: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new CliUsageError(`${flag} must be valid JSON`)
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new CliUsageError(`${flag} must be a JSON object`)
  }

  return value as Record<string, unknown>
}

export function parseCommaList(raw: string, flag: string): string[] {
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

export function consumeBody(opts: {
  positional?: string | undefined
  file?: string | undefined
}): string | undefined {
  if (opts.file) {
    return readFileSync(opts.file, 'utf8')
  }

  if (opts.positional === '-') {
    return readFileSync('/dev/stdin', 'utf8')
  }

  return opts.positional
}

export function exitWithError(err: unknown, opts: { json?: boolean; binName: string }): never {
  const message = err instanceof Error ? err.message : String(err)
  const usage = err instanceof CliUsageError
  const exitCode = usage ? 2 : 1

  if (opts.json) {
    process.stderr.write(`${JSON.stringify({ error: { message, usage } })}\n`)
  } else {
    process.stderr.write(`${opts.binName}: ${message}\n`)
  }

  process.exit(exitCode)
}
