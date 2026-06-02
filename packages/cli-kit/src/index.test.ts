import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'
import {
  CliUsageError,
  attachActorOption,
  attachJsonOption,
  attachServerOption,
  consumeBody,
  exitWithError,
  parseCommaList,
  parseDuration,
  parseIntegerValue,
  parseJsonObject,
  repeatable,
  withDeps,
} from './index.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs.length = 0
})

async function tempFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cli-kit-'))
  tempDirs.push(dir)
  const path = join(dir, 'body.txt')
  await writeFile(path, contents)
  return path
}

// Exercise exitWithError through its injected `write`/`exit` seam rather than
// monkey-patching global `process.exit`/`process.stderr.write`. This keeps the
// test isolated from shared process state (no race with concurrent writers) and
// restores nothing because nothing global was mutated.
function captureExit(
  run: (deps: {
    write: (chunk: string) => void
    exit: (code: number) => never
  }) => never
): { code: number | undefined; stderr: string } {
  let code: number | undefined
  let stderr = ''

  const write = (chunk: string) => {
    stderr += chunk
  }
  const exit = ((exitCode: number) => {
    code = exitCode
    throw new Error('process.exit')
  }) as (code: number) => never

  expect(() => run({ write, exit })).toThrow('process.exit')
  return { code, stderr }
}

describe('commander helpers', () => {
  test('attachJsonOption adds --json', () => {
    const cmd = attachJsonOption(new Command())
    cmd.parse(['node', 'bin', '--json'])
    expect(cmd.opts<{ json?: boolean }>().json).toBe(true)
  })

  test('attachServerOption accepts defaults and overrides', () => {
    const cmd = attachServerOption(new Command(), 'http://default')
    cmd.parse(['node', 'bin'])
    expect(cmd.opts<{ server?: string }>().server).toBe('http://default')

    const overridden = attachServerOption(new Command(), 'http://default')
    overridden.parse(['node', 'bin', '--server', 'http://override'])
    expect(overridden.opts<{ server?: string }>().server).toBe('http://override')
  })

  test('attachActorOption adds --actor', () => {
    const cmd = attachActorOption(new Command())
    cmd.parse(['node', 'bin', '--actor', 'cody'])
    expect(cmd.opts<{ actor?: string }>().actor).toBe('cody')
  })

  test('repeatable accumulates parsed values', () => {
    const collect = repeatable((raw) => Number.parseInt(raw, 10))
    expect(collect('2', collect('1', undefined))).toEqual([1, 2])
  })

  test('repeatable without a parser accumulates raw strings (typed string[])', () => {
    const collect = repeatable()
    const result: string[] = collect('b', collect('a', undefined))
    expect(result).toEqual(['a', 'b'])
  })

  test('withDeps passes options, positionals, and deps to a handler', async () => {
    const calls: unknown[] = []
    const command = new Command().option('--json')
    command.parse(['node', 'bin', '--json'])
    const action = withDeps(
      async (opts, args, deps) => {
        calls.push({ opts, args, deps })
      },
      () => ({ client: 'test' })
    )

    await action('first', 'second', command)

    expect(calls).toEqual([
      { opts: { json: true }, args: ['first', 'second'], deps: { client: 'test' } },
    ])
  })
})

describe('validators', () => {
  test('parseDuration converts supported units to milliseconds', () => {
    expect(parseDuration('5ms')).toBe(5)
    expect(parseDuration('30s')).toBe(30_000)
    expect(parseDuration('5m')).toBe(300_000)
    expect(parseDuration('1h')).toBe(3_600_000)
  })

  test('parseDuration rejects invalid values', () => {
    expect(() => parseDuration('soon')).toThrow(CliUsageError)
  })

  test('parseJsonObject parses objects only', () => {
    expect(parseJsonObject('--meta', '{"a":1}')).toEqual({ a: 1 })
    expect(() => parseJsonObject('--meta', 'nope')).toThrow('--meta must be valid JSON')
    expect(() => parseJsonObject('--meta', '[]')).toThrow('--meta must be a JSON object')
  })

  test('parseCommaList trims values and rejects empty lists', () => {
    expect(parseCommaList('--ids', 'a, b,,c')).toEqual(['a', 'b', 'c'])
    expect(() => parseCommaList('--ids', ' , ')).toThrow('--ids requires at least one value')
  })

  test('parseIntegerValue validates minimums', () => {
    expect(parseIntegerValue('--limit', '4', { min: 1 })).toBe(4)
    expect(() => parseIntegerValue('--limit', '0', { min: 1 })).toThrow(
      '--limit must be an integer >= 1'
    )
  })

  test('consumeBody returns positional text or file contents', async () => {
    const path = await tempFile('from-file')
    expect(consumeBody({ positional: 'inline' })).toBe('inline')
    expect(consumeBody({ file: path, positional: 'ignored' })).toBe('from-file')
  })

  test('consumeBody reads stdin for a "-" positional via the injected reader', () => {
    const reads: string[] = []
    const readFile = (p: string) => {
      reads.push(p)
      return 'from-stdin'
    }
    expect(consumeBody({ positional: '-' }, { readFile })).toBe('from-stdin')
    expect(reads).toEqual(['/dev/stdin'])
  })

  test('consumeBody wraps an unreadable file path as a CliUsageError', () => {
    const readFile = () => {
      throw new Error('ENOENT: no such file or directory')
    }
    expect(() => consumeBody({ file: '/missing' }, { readFile })).toThrow(CliUsageError)
    expect(() => consumeBody({ file: '/missing' }, { readFile })).toThrow(/cannot read --file/)
  })
})

describe('error envelope', () => {
  test('exitWithError emits exit code 2 for CliUsageError', () => {
    const result = captureExit((deps) =>
      exitWithError(new CliUsageError('bad input'), { binName: 'tool' }, deps)
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('tool: bad input\n')
  })

  test('exitWithError emits exit code 1 for other Error types', () => {
    const result = captureExit((deps) =>
      exitWithError(new Error('boom'), { binName: 'tool' }, deps)
    )
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('tool: boom\n')
  })

  test('exitWithError can emit a JSON error envelope', () => {
    const result = captureExit((deps) =>
      exitWithError(new CliUsageError('bad input'), { binName: 'tool', json: true }, deps)
    )
    expect(result.code).toBe(2)
    expect(JSON.parse(result.stderr)).toEqual({ error: { message: 'bad input', usage: true } })
  })
})

describe('bun commander smoke', () => {
  test('program.exitOverride throws cleanly under bun runtime', () => {
    const program = new Command()
    program.exitOverride((err) => {
      throw err
    })

    expect(() => program.parse(['node', 'bin', '--unknown'])).toThrow()
  })
})
