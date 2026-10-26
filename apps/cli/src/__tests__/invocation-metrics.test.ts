/**
 * asp CLI invocation records (T-11824).
 *
 * Failure modes: an argument VALUE (prompt, path, scope, model) reaches the
 * row; --help goes unrecorded or unmarked; the exit code is not the one the
 * caller saw; a broken metrics dir changes stdout, stderr or the exit code; the
 * record is lost on an error exit.
 */

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BIN = join(import.meta.dir, '..', '..', 'bin', 'asp.js')
const roots: string[] = []

afterAll(() => {
  for (const root of roots) {
    try {
      chmodSync(join(root, 'state', 'agent-spaces', 'metrics'), 0o755)
    } catch {}
    rmSync(root, { recursive: true, force: true })
  }
})

function asp(args: string[], env: Record<string, string> = {}, varRoot?: string) {
  const root = varRoot ?? mkdtempSync(join(tmpdir(), 'asp-cli-metrics-'))
  if (!varRoot) roots.push(root)
  const { ASP_PROJECT: _p, ASP_AGENT_ID: _a, AGENTCHAT_ID: _c, ...base } = process.env
  const result = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...base, ...env, ASP_USAGE_METRICS_VAR_ROOT: root },
    encoding: 'utf8',
    timeout: 30_000,
  })
  const dir = join(root, 'state', 'agent-spaces', 'metrics')
  const rows = existsSync(dir)
    ? readdirSync(dir)
        .filter((name) => name.startsWith('asp-cli-'))
        .flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n').filter(Boolean))
    : []
  return {
    result,
    rows,
    row: rows.length > 0 ? JSON.parse(rows[rows.length - 1] as string) : undefined,
  }
}

describe('asp invocation records', () => {
  test('records the command path, flag names, exit code and envelope', () => {
    const { result, row, rows } = asp(['harnesses', '--json'])
    expect(result.status).toBe(0)
    expect(rows).toHaveLength(1)
    expect(row).toMatchObject({
      v: 1,
      kind: 'invocation',
      component: 'asp-cli',
      product: expect.stringMatching(/^asp\/\d+\.\d+\.\d+/),
      host: 'asp',
      cmd: 'harnesses',
      flags: ['--json'],
      exitCode: 0,
      tty: false,
      compile: expect.stringMatching(/^(none|in-process)$/),
    })
    expect(row.durMs).toBeGreaterThan(0)
    expect(row).not.toHaveProperty('help')
  })

  test('marks --help and nested help', () => {
    expect(asp(['--help']).row).toMatchObject({ cmd: '', help: true, exitCode: 0 })
    expect(asp(['agent', '--help']).row).toMatchObject({
      cmd: 'agent',
      flags: ['--help'],
      help: true,
      exitCode: 0,
    })
  })

  test('records usage errors with the exit code the caller saw', () => {
    const { result, row } = asp(['lint', '--bogus'])
    expect(result.status).toBe(2)
    expect(row).toMatchObject({ cmd: 'lint', flags: [], unknownFlags: 1, exitCode: 2 })
  })

  test('never records argument values, only flag names, plus project and agent from env', () => {
    const secrets = [
      'SECRET-PROMPT-TEXT',
      'secret-model-x',
      '/nonexistent/secret-root',
      'zed@nowhere:t9',
    ]
    const { result, rows, row } = asp(
      [
        'agent',
        'zed@nowhere:t9',
        'query',
        'SECRET-PROMPT-TEXT',
        '--model',
        'secret-model-x',
        '--agent-root=/nonexistent/secret-root',
        '--dry-run',
      ],
      { ASP_PROJECT: 'proj-x', ASP_AGENT_ID: 'agent-y' }
    )
    expect(result.status).not.toBe(0)
    expect(row).toMatchObject({
      cmd: 'agent',
      flags: ['--model', '--agent-root', '--dry-run'],
      exitCode: result.status,
      project: 'proj-x',
      agent: 'agent-y',
    })
    for (const secret of secrets) expect(rows.join('\n')).not.toContain(secret)
    expect(rows.join('\n')).not.toContain(process.cwd())
  })

  test('an unwritable metrics dir changes nothing the caller sees', () => {
    const normal = asp(['lint', '--bogus'])
    const root = mkdtempSync(join(tmpdir(), 'asp-cli-metrics-broken-'))
    roots.push(root)
    const dir = join(root, 'state', 'agent-spaces', 'metrics')
    mkdirSync(dir, { recursive: true })
    chmodSync(dir, 0o500)
    const broken = asp(['lint', '--bogus'], {}, root)
    for (const run of [
      [normal, broken],
      [asp(['harnesses', '--json']), asp(['harnesses', '--json'], {}, root)],
    ] as const) {
      expect(run[1].result.status).toBe(run[0].result.status)
      expect(run[1].result.stdout).toBe(run[0].result.stdout)
      expect(run[1].result.stderr).toBe(run[0].result.stderr)
    }
    expect(broken.rows).toEqual([])
  })
})
