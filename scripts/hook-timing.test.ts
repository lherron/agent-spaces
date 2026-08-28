import { afterEach, describe, expect, test } from 'bun:test'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { buildHookStats, percentile } from './hook-stats.ts'
import { HOOK_TIMINGS_PATH_ENV, readTimingRecords } from './lib/hook-timing.ts'
import type { HookStepTimingRecord, HookTimingRecord, TimingRecord } from './lib/hook-timing.ts'

const repoRoot = resolve(new URL('..', import.meta.url).pathname)
const wrapper = join(repoRoot, 'scripts', 'run-lefthook-with-timing.ts')
const stepWrapper = join(repoRoot, 'scripts', 'run-hook-command.ts')
const scopeWrapper = join(repoRoot, 'scripts', 'run-if-code-changed.ts')
const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => await rm(root, { recursive: true }))
  )
})

function run(
  command: string[],
  cwd: string,
  options: { env?: Record<string, string>; stdin?: string; expectedExitCode?: number } = {}
): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...options.env },
    stdin: options.stdin === undefined ? undefined : Buffer.from(options.stdin),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const output = `${result.stdout.toString()}${result.stderr.toString()}`
  expect(result.exitCode, `${command.join(' ')}\n${output}`).toBe(options.expectedExitCode ?? 0)
  return output
}

async function makeFixture(): Promise<{
  binDir: string
  logPath: string
  work: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'agent-spaces-hook-timing-'))
  temporaryRoots.push(root)
  const work = join(root, 'work')
  const binDir = join(root, 'bin')
  const logPath = join(root, 'hook-timings.jsonl')
  await mkdir(work, { recursive: true })
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'hook-probe'), '#!/bin/sh\nprintf "%s\\n" "$*"\n')
  await chmod(join(binDir, 'hook-probe'), 0o755)
  run(['git', 'init', '-b', 'main'], work)
  run(['git', 'config', 'user.name', 'Hook Timing Test'], work)
  run(['git', 'config', 'user.email', 'hook-timing@example.com'], work)
  await writeFile(join(work, 'README.md'), '# baseline\n')
  run(['git', 'add', 'README.md'], work)
  run(['git', 'commit', '-m', 'baseline'], work)
  return { binDir, logPath, work }
}

function hookEnv(fixture: { binDir: string; logPath: string }): Record<string, string> {
  return {
    [HOOK_TIMINGS_PATH_ENV]: fixture.logPath,
    PATH: `${fixture.binDir}:${process.env['PATH'] ?? ''}`,
  }
}

async function recordsAt(path: string): Promise<TimingRecord[]> {
  return (await readTimingRecords(path)).records
}

describe('installed Lefthook timing wrapper', () => {
  test('records one correlated total and step while preserving pre-commit output', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.work, 'lefthook.yml'),
      `min_version: "2.1.10"
pre-commit:
  commands:
    probe:
      run: bun ${JSON.stringify(stepWrapper)} pre-commit {lefthook_job_name} -- hook-probe success
`
    )
    await writeFile(join(fixture.work, 'code.ts'), 'export const timed = true\n')
    run(['git', 'add', 'code.ts'], fixture.work)

    const output = run(['bun', wrapper, 'run', 'pre-commit'], fixture.work, {
      env: hookEnv(fixture),
    })
    expect(output).toContain('success')

    const records = await recordsAt(fixture.logPath)
    expect(records).toHaveLength(2)
    const step = records.find(
      (record): record is HookStepTimingRecord => record.recordType === 'step'
    )
    const hook = records.find((record): record is HookTimingRecord => record.recordType === 'hook')
    expect(step?.step).toBe('probe')
    expect(step?.result).toBe('passed')
    expect(step?.change).toEqual({ kind: 'code', fileCount: 1 })
    expect(hook?.result).toBe('passed')
    expect(hook?.change).toEqual({ kind: 'code', fileCount: 1 })
    expect(step?.runId).toBe(hook?.runId)
    expect(hook?.durationMs).toBeGreaterThanOrEqual(step?.durationMs ?? Number.POSITIVE_INFINITY)
    expect(JSON.stringify(records)).not.toContain('code.ts')
    expect(JSON.stringify(records)).not.toContain('success')
  })

  test('preserves pre-push stdin and records a documentation skip', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.work, 'lefthook.yml'),
      `min_version: "2.1.10"
pre-push:
  files: printf 'lefthook.yml\\n'
  commands:
    validation:
      use_stdin: true
      run: bun ${JSON.stringify(scopeWrapper)} pre-push {lefthook_job_name} -- hook-probe should-not-run
`
    )
    const remoteOid = run(['git', 'rev-parse', 'HEAD'], fixture.work).trim()
    await writeFile(join(fixture.work, 'README.md'), '# documentation update\n')
    run(['git', 'add', 'README.md'], fixture.work)
    run(['git', 'commit', '-m', 'docs'], fixture.work)
    const localOid = run(['git', 'rev-parse', 'HEAD'], fixture.work).trim()
    const stdin = `refs/heads/main ${localOid} refs/heads/main ${remoteOid}\n`

    const output = run(['bun', wrapper, 'run', 'pre-push'], fixture.work, {
      env: hookEnv(fixture),
      stdin,
    })
    expect(output).toContain('skipping code validation for 1 documentation file(s)')
    expect(output).not.toContain('should-not-run')

    const records = await recordsAt(fixture.logPath)
    const step = records.find(
      (record): record is HookStepTimingRecord => record.recordType === 'step'
    )
    const hook = records.find((record): record is HookTimingRecord => record.recordType === 'hook')
    expect(step?.result).toBe('skipped')
    expect(step?.change).toEqual({ kind: 'documentation', fileCount: 1 })
    expect(hook?.result).toBe('passed')
    expect(hook?.change).toEqual({ kind: 'documentation', fileCount: 1 })
  })

  test('records failure while returning Lefthook failure unchanged', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.work, 'lefthook.yml'),
      `min_version: "2.1.10"
pre-commit:
  commands:
    failure:
      run: bun ${JSON.stringify(stepWrapper)} pre-commit {lefthook_job_name} -- sh -c 'exit 7'
`
    )
    await writeFile(join(fixture.work, 'code.ts'), 'export const failure = true\n')
    run(['git', 'add', 'code.ts'], fixture.work)

    run(['bun', wrapper, 'run', 'pre-commit'], fixture.work, {
      env: hookEnv(fixture),
      expectedExitCode: 1,
    })
    const records = await recordsAt(fixture.logPath)
    expect(records.find((record) => record.recordType === 'step')?.result).toBe('failed')
    expect(records.find((record) => record.recordType === 'hook')?.result).toBe('failed')
  })

  test('never blocks a successful hook when timing storage is unwritable', async () => {
    const fixture = await makeFixture()
    await writeFile(
      join(fixture.work, 'lefthook.yml'),
      `min_version: "2.1.10"
pre-commit:
  commands:
    probe:
      run: bun ${JSON.stringify(stepWrapper)} pre-commit {lefthook_job_name} -- hook-probe still-passes
`
    )
    await writeFile(join(fixture.work, 'code.ts'), 'export const telemetryFailure = true\n')
    run(['git', 'add', 'code.ts'], fixture.work)

    const output = run(['bun', wrapper, 'run', 'pre-commit'], fixture.work, {
      env: {
        ...hookEnv(fixture),
        [HOOK_TIMINGS_PATH_ENV]: fixture.work,
      },
    })
    expect(output).toContain('still-passes')
    expect(output).toContain('[hook-timing] unable to record timing')
  })
})

describe('hook timing statistics', () => {
  test('uses nearest-rank percentiles and groups hook and step outcomes', () => {
    expect(percentile([100, 200, 300, 400], 0.5)).toBe(200)
    expect(percentile([100, 200, 300, 400], 0.95)).toBe(400)

    const base = {
      schemaVersion: 1 as const,
      recordedAt: '2026-08-28T20:00:00.000Z',
      runId: 'run-1',
      hook: 'pre-commit' as const,
      startedAt: '2026-08-28T19:59:59.000Z',
      exitCode: 0,
      change: { kind: 'code' as const, fileCount: 1 },
    }
    const records: TimingRecord[] = [
      {
        ...base,
        recordType: 'hook',
        finishedAt: '2026-08-28T20:00:00.000Z',
        durationMs: 1000,
        result: 'passed',
        platform: 'darwin',
        arch: 'arm64',
        bunVersion: '1.3.14',
      },
      {
        ...base,
        recordType: 'step',
        step: 'build',
        durationMs: 900,
        result: 'passed',
      },
      {
        ...base,
        runId: 'run-2',
        recordType: 'step',
        step: 'build',
        durationMs: 50,
        result: 'skipped',
      },
    ]

    const stats = buildHookStats(records, Date.parse('2026-08-28T19:00:00.000Z'))
    expect(stats.hookStats[0]?.durations).toEqual({
      count: 1,
      p50Ms: 1000,
      p95Ms: 1000,
      maxMs: 1000,
    })
    expect(stats.stepStats[0]?.results).toEqual({ passed: 1, failed: 0, skipped: 1 })
  })

  test('ignores malformed JSONL records without discarding valid history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-spaces-hook-records-'))
    temporaryRoots.push(root)
    const path = join(root, 'timings.jsonl')
    await writeFile(
      path,
      `${JSON.stringify({ schemaVersion: 1, recordType: 'step', runId: 'one', durationMs: 3 })}\nnot-json\n`
    )

    const result = await readTimingRecords(path)
    expect(result.records).toHaveLength(1)
    expect(result.malformedLines).toBe(1)
  })
})
