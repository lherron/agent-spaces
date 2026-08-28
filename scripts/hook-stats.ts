import type { HookName } from './lib/hook-change-scope.ts'
import { readTimingRecords, resolveHookTimingsPath } from './lib/hook-timing.ts'
import type { HookStepTimingRecord, HookTimingRecord, TimingRecord } from './lib/hook-timing.ts'

interface CliOptions {
  path: string
  sinceMs: number
  sinceLabel: string
  json: boolean
}

interface DurationSummary {
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

interface ResultCounts {
  passed: number
  failed: number
  skipped: number
}

function parseDuration(value: string): number {
  const match = /^(\d+)(m|h|d|w)$/.exec(value)
  if (!match)
    throw new Error(`invalid --since value ${JSON.stringify(value)}; use 30m, 24h, 7d, or 4w`)
  const count = Number(match[1])
  const unitMs = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[
    match[2] as 'm' | 'h' | 'd' | 'w'
  ]
  return count * unitMs
}

function parseArgs(argv: string[]): CliOptions {
  let path = resolveHookTimingsPath()
  let sinceLabel = '30d'
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--path') {
      const value = argv[++index]
      if (!value) throw new Error('--path requires a value')
      path = value
      continue
    }
    if (arg === '--since') {
      const value = argv[++index]
      if (!value) throw new Error('--since requires a value')
      sinceLabel = value
      continue
    }
    if (arg === '--json') {
      json = true
      continue
    }
    throw new Error(`unknown argument: ${arg}`)
  }
  return { path, sinceMs: parseDuration(sinceLabel), sinceLabel, json }
}

function printUsage(): void {
  console.log(`usage: bun run hook:stats [--since <duration>] [--path <jsonl>] [--json]

Report locally recorded pre-commit and pre-push timing trends.
Durations accept minutes, hours, days, or weeks (for example: 30m, 24h, 7d, 4w).`)
}

export function percentile(values: number[], percentileValue: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1)
  return sorted[index] ?? 0
}

function durationSummary(records: Array<{ durationMs: number }>): DurationSummary {
  const durations = records.map((record) => record.durationMs)
  return {
    count: records.length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations.length === 0 ? 0 : Math.max(...durations),
  }
}

function resultCounts(records: Array<{ result: TimingRecord['result'] }>): ResultCounts {
  const counts: ResultCounts = { passed: 0, failed: 0, skipped: 0 }
  for (const record of records) counts[record.result] += 1
  return counts
}

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(0)}ms`
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>()
  for (const value of values) {
    const groupKey = key(value)
    const group = groups.get(groupKey) ?? []
    group.push(value)
    groups.set(groupKey, group)
  }
  return groups
}

export function buildHookStats(records: TimingRecord[], cutoff: number) {
  const recent = records.filter((record) => Date.parse(record.recordedAt) >= cutoff)
  const hooks = recent.filter((record): record is HookTimingRecord => record.recordType === 'hook')
  const steps = recent.filter(
    (record): record is HookStepTimingRecord => record.recordType === 'step'
  )

  const hookStats = [...groupBy(hooks, (record) => record.hook).entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([hook, hookRecords]) => ({
      hook: hook as HookName,
      durations: durationSummary(hookRecords),
      results: resultCounts(hookRecords),
    }))

  const stepStats = [...groupBy(steps, (record) => `${record.hook}/${record.step}`).entries()]
    .map(([step, stepRecords]) => ({
      step,
      durations: durationSummary(stepRecords),
      results: resultCounts(stepRecords),
    }))
    .sort((left, right) => right.durations.p95Ms - left.durations.p95Ms)

  return { hookStats, stepStats }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    return
  }
  const options = parseArgs(argv)
  const { records, malformedLines } = await readTimingRecords(options.path)
  const stats = buildHookStats(records, Date.now() - options.sinceMs)
  const report = {
    schemaVersion: 1,
    path: options.path,
    since: options.sinceLabel,
    malformedLines,
    ...stats,
  }
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`Hook timings: ${options.path}`)
  console.log(`Window: ${options.sinceLabel}`)
  if (stats.hookStats.length === 0) {
    console.log('No hook invocations recorded in this window.')
    return
  }

  console.log('')
  console.log('Hooks')
  for (const item of stats.hookStats) {
    const { durations, results } = item
    console.log(
      `${item.hook.padEnd(12)} n=${durations.count} pass=${results.passed} fail=${results.failed} skip=${results.skipped} p50=${formatMs(durations.p50Ms)} p95=${formatMs(durations.p95Ms)} max=${formatMs(durations.maxMs)}`
    )
  }

  if (stats.stepStats.length > 0) {
    console.log('')
    console.log('Slowest steps by p95')
    for (const item of stats.stepStats.slice(0, 10)) {
      const { durations, results } = item
      console.log(
        `${item.step.padEnd(34)} n=${durations.count} pass=${results.passed} fail=${results.failed} skip=${results.skipped} p50=${formatMs(durations.p50Ms)} p95=${formatMs(durations.p95Ms)} max=${formatMs(durations.maxMs)}`
      )
    }
  }

  if (malformedLines > 0) console.log(`\nIgnored malformed records: ${malformedLines}`)
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`hook-stats: ${error}`)
    process.exit(2)
  })
}
