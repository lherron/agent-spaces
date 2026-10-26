/**
 * Test-run usage-metrics isolation (T-11824).
 *
 * Failure modes: a test spawns a child with a hand-built env and the child
 * writes the node's real day files; a workspace package runs `bun test`
 * without the shared preload (bun reads bunfig.toml from the cwd only, so a
 * root bunfig does not cover package-dir runs); the guard misattributes foreign
 * rows (live aspd, real agents) to the test run.
 */
import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { USAGE_METRICS_SUBDIR } from 'spaces-config/usage-metrics'
import { ownedUsageMetricsRows, snapshotUsageMetrics } from './lib/usage-metrics-isolation.ts'

const root = resolve(import.meta.dir, '..')
const PRELOAD = join(root, 'scripts', 'test-preload.ts')

describe('usage-metrics isolation', () => {
  test('a child spawned with a hand-built env still writes the scratch root', () => {
    const scratch = process.env['ASP_USAGE_METRICS_VAR_ROOT']
    expect(scratch, 'the preload sets a scratch root').toBeTruthy()
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        "const m = await import('spaces-config/usage-metrics'); m.usageMetrics('isolation-probe').record('probe', { ok: true })",
      ],
      // Deliberately NOT process.env: only what a test typically keeps.
      { cwd: root, env: { PATH: process.env['PATH'], HOME: process.env['HOME'] }, encoding: 'utf8' }
    )
    expect(result.status, result.stderr).toBe(0)
    const dir = join(scratch as string, USAGE_METRICS_SUBDIR)
    const rows = readdirSync(dir)
      .filter((name) => name.startsWith('isolation-probe-'))
      .flatMap((name) => readFileSync(join(dir, name), 'utf8').trim().split('\n'))
      .map((line) => JSON.parse(line))
    expect(rows).toContainEqual(expect.objectContaining({ kind: 'probe', pid: result.pid }))
  })

  test('the guard attributes only rows written by the run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'asp-guard-'))
    writeFileSync(join(dir, 'asp-cli-2026-10-26.ndjson'), `${JSON.stringify({ pid: 1 })}\n`)
    const snapshot = snapshotUsageMetrics(dir)
    writeFileSync(
      join(dir, 'asp-cli-2026-10-26.ndjson'),
      `${[{ pid: 1 }, { pid: 41 }, { pid: 42 }].map((row) => JSON.stringify(row)).join('\n')}\n`
    )
    writeFileSync(join(dir, 'paths-2026-10-26.ndjson'), `${JSON.stringify({ pid: 42 })}\npartial`)
    expect(ownedUsageMetricsRows(snapshot, new Set([42]), dir)).toEqual([
      { file: 'asp-cli-2026-10-26.ndjson', pid: 42 },
      { file: 'paths-2026-10-26.ndjson', pid: 42 },
    ])
  })

  test('every workspace package runs bun test with the shared preload', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      workspaces: string[]
    }
    const dirs = [root]
    for (const pattern of manifest.workspaces) {
      if (!pattern.endsWith('/*')) {
        dirs.push(join(root, pattern))
        continue
      }
      const parent = join(root, pattern.slice(0, -2))
      for (const name of readdirSync(parent)) {
        if (existsSync(join(parent, name, 'package.json'))) dirs.push(join(parent, name))
      }
    }
    const missing: string[] = []
    for (const dir of dirs) {
      const script = (
        JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
          scripts?: Record<string, string>
        }
      ).scripts?.['test']
      // Scripts that `cd` to the repo root before `bun test` use the root bunfig.
      if (dir !== root && (script === undefined || /^cd \.\.\/\.\. && /.test(script))) continue
      const bunfig = join(dir, 'bunfig.toml')
      const preload = existsSync(bunfig)
        ? /preload\s*=\s*\["([^"]+)"\]/.exec(readFileSync(bunfig, 'utf8'))?.[1]
        : undefined
      if (preload === undefined || resolve(dirname(bunfig), preload) !== PRELOAD) {
        missing.push(dir.slice(root.length + 1) || '.')
      }
    }
    expect(missing, 'add bunfig.toml with [test] preload = scripts/test-preload.ts').toEqual([])
  })
})
