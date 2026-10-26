/**
 * Usage-metrics day-file writer (T-11824).
 *
 * WHY: every ASP usage stream (aspd requests, asp CLI invocations, compile-path
 * markers) goes through this writer, so its failure modes are the ones that
 * matter: counts must be exact, a broken disk must never reach the caller, a
 * day file must stop at its cap, and a SIGTERM must not lose the open minute.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  USAGE_METRICS_SUBDIR,
  USAGE_METRICS_VAR_ROOT_ENV,
  type UsageMetricWarning,
  createUsageMetrics,
  resolveUsageMetricsDir,
  usageMetricsHostName,
} from './index.js'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'usage-metrics-'))
})

afterEach(() => {
  try {
    chmodSync(root, 0o755)
  } catch {}
  rmSync(root, { recursive: true, force: true })
})

function rows(dir: string, file: string): Record<string, unknown>[] {
  return readFileSync(join(dir, file), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

const T0 = Date.parse('2026-10-26T10:15:30.000Z')

describe('resolveUsageMetricsDir', () => {
  it('prefers the scratch env override, then the host var root, then ~/praesidium/var', () => {
    expect(resolveUsageMetricsDir({ env: { [USAGE_METRICS_VAR_ROOT_ENV]: '/scratch/var' } })).toBe(
      join('/scratch/var', USAGE_METRICS_SUBDIR)
    )
    expect(resolveUsageMetricsDir({ env: {}, varRoot: '/ns/var' })).toBe(
      join('/ns/var', USAGE_METRICS_SUBDIR)
    )
    expect(resolveUsageMetricsDir({ env: {} })).toMatch(
      /praesidium\/var\/state\/agent-spaces\/metrics$/
    )
  })
})

describe('createUsageMetrics', () => {
  it('aggregates exact counts per key per minute with sum/max measures', () => {
    let now = T0
    const metrics = createUsageMetrics({
      component: 'aspd',
      product: 'aspd/test-1',
      dir: root,
      now: () => now,
    })
    for (let i = 0; i < 1000; i++) {
      metrics.count('request', { op: 'aspc.hello', client: 'hrc/1', outcome: 'ok' }, { ms: 1 })
    }
    metrics.count('request', { op: 'aspc.hello', client: 'hrc/1', outcome: 'ok' }, { ms: 7.25 })
    metrics.count('request', { client: 'hrc/1', op: 'nope', outcome: '-32601' })
    now += 60_000
    metrics.count('request', { op: 'aspc.hello', client: 'hrc/1', outcome: 'ok' }, { ms: 2 })
    metrics.flushSync()

    const written = rows(root, 'aspd-2026-10-26.ndjson')
    expect(written).toHaveLength(3)
    const first = written.find(
      (r) => r['op'] === 'aspc.hello' && r['ts'] === '2026-10-26T10:15:00.000Z'
    )
    expect(first).toMatchObject({
      v: 1,
      kind: 'request',
      component: 'aspd',
      product: 'aspd/test-1',
      host: usageMetricsHostName(),
      pid: process.pid,
      count: 1001,
      msSum: 1007.3,
      msMax: 7.3,
    })
    expect(typeof first?.['node']).toBe('string')
    expect(written.find((r) => r['op'] === 'nope')).toMatchObject({ count: 1, outcome: '-32601' })
    expect(written.find((r) => r['ts'] === '2026-10-26T10:16:00.000Z')).toMatchObject({
      count: 1,
      msSum: 2,
    })
  })

  it('writes plain records with the common envelope and ignores envelope overrides', () => {
    const metrics = createUsageMetrics({
      component: 'asp-cli',
      product: 'asp/0.0.0',
      dir: root,
      now: () => T0,
    })
    metrics.record('invocation', { cmd: 'run', exitCode: 0, pid: 1, kind: 'bogus' })
    metrics.flushSync()
    const [row] = rows(root, 'asp-cli-2026-10-26.ndjson')
    expect(row).toMatchObject({
      v: 1,
      kind: 'invocation',
      ts: '2026-10-26T10:15:30.000Z',
      component: 'asp-cli',
      product: 'asp/0.0.0',
      pid: process.pid,
      cmd: 'run',
      exitCode: 0,
    })
  })

  it('prunes day files older than 14 days by filename date, only for its component', () => {
    for (const name of [
      'aspd-2026-10-12.ndjson', // 14 days old: pruned
      'aspd-2026-10-13.ndjson', // 13 days old: kept
      'aspd-2026-01-01.ndjson',
      'asp-cli-2026-01-01.ndjson', // another component
      'aspd-notes.txt',
    ]) {
      writeFileSync(join(root, name), '{}\n')
    }
    const metrics = createUsageMetrics({
      component: 'aspd',
      product: 'aspd/t',
      dir: root,
      now: () => T0,
    })
    metrics.record('request', { op: 'x' })
    metrics.flushSync()
    expect(readdirSync(root).sort()).toEqual([
      'asp-cli-2026-01-01.ndjson',
      'aspd-2026-10-13.ndjson',
      'aspd-2026-10-26.ndjson',
      'aspd-notes.txt',
    ])
  })

  it('stops writing a day file at its cap, counts the drops and warns once', () => {
    const warnings: Parameters<UsageMetricWarning>[] = []
    const metrics = createUsageMetrics({
      component: 'aspd',
      product: 'aspd/t',
      dir: root,
      now: () => T0,
      maxDayFileBytes: 2048,
      warn: (event, data) => warnings.push([event, data]),
    })
    for (let i = 0; i < 50; i++) metrics.record('request', { op: 'x', i })
    metrics.flushSync()
    for (let i = 0; i < 5; i++) metrics.record('request', { op: 'y', i })
    metrics.flushSync()
    const size = readFileSync(join(root, 'aspd-2026-10-26.ndjson')).byteLength
    expect(size).toBeLessThanOrEqual(2048)
    const written = rows(root, 'aspd-2026-10-26.ndjson').length
    expect(metrics.dropped()).toBe(55 - written)
    expect(warnings.map(([event]) => event)).toEqual(['metrics.cap_reached'])
  })

  it('never throws into the caller when the metrics dir is unwritable', async () => {
    const dir = join(root, 'metrics')
    mkdirSync(dir)
    chmodSync(dir, 0o500)
    const warnings: string[] = []
    const metrics = createUsageMetrics({
      component: 'aspd',
      product: 'aspd/t',
      dir,
      warn: (event) => warnings.push(event),
    })
    metrics.count('request', { op: 'x' }, { ms: 1 })
    metrics.record('invocation', { cmd: 'run' })
    expect(() => metrics.flushSync()).not.toThrow()
    metrics.count('request', { op: 'x' })
    await expect(metrics.flush()).resolves.toBeUndefined()
    expect(metrics.dropped()).toBe(3)
    expect(warnings).toEqual(['metrics.write_failed'])
    expect(existsSync(join(dir, 'aspd-2026-10-26.ndjson'))).toBe(false)
  })

  it('reports earlier drops in a metrics.dropped row once writing recovers', () => {
    const dir = join(root, 'metrics')
    mkdirSync(dir)
    chmodSync(dir, 0o500)
    const metrics = createUsageMetrics({ component: 'aspd', product: 'aspd/t', dir, now: () => T0 })
    metrics.record('request', { op: 'lost' })
    metrics.flushSync()
    chmodSync(dir, 0o755)
    metrics.record('request', { op: 'kept' })
    metrics.flushSync()
    const written = rows(dir, 'aspd-2026-10-26.ndjson')
    expect(written.map((r) => r['kind'])).toEqual(['request', 'metrics.dropped'])
    expect(written[1]).toMatchObject({ count: 1 })
  })
})

describe('process exit and SIGTERM', () => {
  const moduleUrl = new URL('./index.ts', import.meta.url).href

  function runChild(script: string, signal?: NodeJS.Signals) {
    return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      const child = spawn(process.execPath, ['-e', script], {
        env: { ...process.env, [USAGE_METRICS_VAR_ROOT_ENV]: root },
        stdio: ['ignore', 'pipe', 'inherit'],
      })
      child.stdout.on('data', (chunk: Buffer) => {
        if (signal && chunk.toString().includes('ready')) child.kill(signal)
      })
      child.on('exit', (code, sig) => resolve({ code, signal: sig }))
    })
  }

  it('flushes the open minute on a clean exit', async () => {
    const result = await runChild(
      `const m = await import(${JSON.stringify(moduleUrl)});
       const metrics = m.usageMetrics('probe');
       metrics.count('request', { op: 'a' });
       metrics.count('request', { op: 'a' });
       process.exitCode = 3`
    )
    expect(result.code).toBe(3)
    const dir = join(root, USAGE_METRICS_SUBDIR)
    const [file] = readdirSync(dir)
    expect(rows(dir, file as string)).toMatchObject([{ kind: 'request', op: 'a', count: 2 }])
  })

  it('flushes on SIGTERM, runs exit hooks, and still dies by the signal', async () => {
    const result = await runChild(
      `const m = await import(${JSON.stringify(moduleUrl)});
       m.configureUsageMetricsHost({ product: 'probe/1' });
       const metrics = m.usageMetrics('probe');
       metrics.count('request', { op: 'a' });
       metrics.onExit((exit) => metrics.record('invocation', { exitCode: exit.code, signal: exit.signal ?? null }));
       setInterval(() => {}, 1000);
       console.log('ready')`,
      'SIGTERM'
    )
    expect(result.signal).toBe('SIGTERM')
    const dir = join(root, USAGE_METRICS_SUBDIR)
    const [file] = readdirSync(dir)
    const written = rows(dir, file as string)
    expect(written).toMatchObject([
      { kind: 'request', op: 'a', count: 1, product: 'probe/1' },
      { kind: 'invocation', exitCode: 143, signal: 'SIGTERM' },
    ])
  })
})
