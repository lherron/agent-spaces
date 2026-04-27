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

function captureExit(fn: () => never): { code: number | undefined; stderr: string } {
  const originalExit = process.exit
  const originalWrite = process.stderr.write
  let code: number | undefined
  let stderr = ''

  process.exit = ((exitCode?: number | string | null) => {
    code = typeof exitCode === 'number' ? exitCode : undefined
    throw new Error('process.exit')
  }) as typeof process.exit
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString()
    return true
  }) as typeof process.stderr.write

  try {
    expect(fn).toThrow('process.exit')
    return { code, stderr }
  } finally {
    process.exit = originalExit
    process.stderr.write = originalWrite
  }
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
    expect(parseCommaList('a, b,,c', '--ids')).toEqual(['a', 'b', 'c'])
    expect(() => parseCommaList(' , ', '--ids')).toThrow('--ids requires at least one value')
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
})

describe('error envelope', () => {
  test('exitWithError emits exit code 2 for CliUsageError', () => {
    const result = captureExit(() =>
      exitWithError(new CliUsageError('bad input'), { binName: 'tool' })
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toBe('tool: bad input\n')
  })

  test('exitWithError emits exit code 1 for other Error types', () => {
    const result = captureExit(() => exitWithError(new Error('boom'), { binName: 'tool' }))
    expect(result.code).toBe(1)
    expect(result.stderr).toBe('tool: boom\n')
  })

  test('exitWithError can emit a JSON error envelope', () => {
    const result = captureExit(() =>
      exitWithError(new CliUsageError('bad input'), { binName: 'tool', json: true })
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
