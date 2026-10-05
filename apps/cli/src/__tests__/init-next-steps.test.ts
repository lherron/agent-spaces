/**
 * `asp init` prints next-step commands; each one must be accepted by the
 * parser it names (T-10322: `asp run --target dev` was an unknown option).
 */

import { afterEach, expect } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cliTest } from './asp-cli.js'

const ASP_CLI = join(import.meta.dirname, '..', '..', 'bin', 'asp.js')
const USAGE_ERROR = /error: (unknown option|missing required|too many arguments|unknown command)/

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function asp(args: string[], cwd: string, aspHome: string) {
  const result = spawnSync('bun', ['run', ASP_CLI, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ASP_HOME: aspHome, NO_COLOR: '1' },
  })
  return { exitCode: result.status, output: `${result.stdout}${result.stderr}` }
}

cliTest('every next step asp init prints parses', () => {
  const base = mkdtempSync(join(tmpdir(), 'asp-init-'))
  dirs.push(base)
  const project = join(base, 'project')
  const aspHome = join(base, 'asp-home')
  mkdirSync(project)
  mkdirSync(aspHome)

  const init = asp(['init'], project, aspHome)
  expect(init.exitCode).toBe(0)
  const steps = [...init.output.matchAll(/^\s+\d+\. [^:]+:\s+asp (.+)$/gm)].map((match) =>
    (match[1] as string).trim().split(/\s+/)
  )
  expect(steps.map((argv) => argv[0])).toEqual(['add', 'install', 'run'])

  for (const argv of steps) {
    // Never launch a harness from a test; --dry-run leaves the parsed command intact.
    const args = argv[0] === 'run' ? [...argv, '--dry-run'] : argv
    const result = asp(args, project, aspHome)
    expect({ step: argv.join(' '), usageError: result.output.match(USAGE_ERROR)?.[0] }).toEqual({
      step: argv.join(' '),
      usageError: undefined,
    })
    expect(result.exitCode).not.toBe(2)
  }
})
