/**
 * ASP usage metrics: NDJSON day files that say which ASP surfaces and code
 * paths are live (T-11824). One writer serves every stream: aspd request
 * counts, asp CLI invocation records and compile-path markers.
 *
 * Files are `<metrics dir>/<component>-<YYYY-MM-DD>.ndjson` (UTC day). They are
 * state, not logs (logging.md L1 covers `*.log`), so they live under
 * `var/state/agent-spaces/metrics` and prune themselves.
 *
 * Contract with callers: recording never throws, never touches the disk on the
 * caller's stack, and a metrics failure costs at most one warning through the
 * host's `warn` sink (silent by default). Counts are exact, never sampled.
 */
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs'
import { appendFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, join } from 'node:path'

/** Metrics dir relative to the Praesidium var root. The one place to move it. */
export const USAGE_METRICS_SUBDIR = join('state', 'agent-spaces', 'metrics')
/** Scratch override for the var root (tests, scratch daemons). Never disables recording. */
export const USAGE_METRICS_VAR_ROOT_ENV = 'ASP_USAGE_METRICS_VAR_ROOT'
/** Day files kept per component, today included. */
export const USAGE_METRICS_RETENTION_DAYS = 14
export const USAGE_METRICS_MAX_DAY_FILE_BYTES = 64 * 1024 * 1024
/** Bounds on unflushed state; past them a row is dropped and counted. */
const MAX_PENDING_RECORDS = 10_000
const MAX_KEYS_PER_MINUTE = 5_000
const MAX_STRING_CHARS = 128
const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

export type UsageMetricKeyValue = string | number | boolean
export type UsageMetricKey = Record<string, UsageMetricKeyValue>
export type UsageMetricWarningEvent =
  | 'metrics.cap_reached'
  | 'metrics.write_failed'
  | 'metrics.prune_failed'
export type UsageMetricWarning = (
  event: UsageMetricWarningEvent,
  data: Record<string, unknown>
) => void

export type UsageCompileMode = 'none' | 'in-process' | 'aspd' | 'mixed'

export interface UsageMetricsExit {
  /** Process exit code; 128 + signal number when a signal ended it. */
  code: number
  signal?: NodeJS.Signals | undefined
}

export interface UsageMetrics {
  /** Append one row as given (plus the common envelope). `fields.ts` may set its time. */
  record(kind: string, fields: Record<string, unknown>): void
  /**
   * Add one occurrence of `key` to the current minute. Each measure accumulates
   * `<name>Sum` and `<name>Max`. One row per (kind, key, minute) is written.
   */
  count(kind: string, key: UsageMetricKey, measures?: Record<string, number>): void
  /** Write everything buffered, including the open minute. Never rejects. */
  flush(): Promise<void>
  /** Synchronous `flush`, for exit paths. Never throws. */
  flushSync(): void
  /** Rows dropped since this writer started (cap, bounds, write failures). */
  dropped(): number
  /** Run `fn` once before the final flush at process exit, SIGTERM or SIGINT. */
  onExit(fn: (exit: UsageMetricsExit) => void): void
}

export interface UsageMetricsHost {
  /** `<name>/<version>` of the program running this process. */
  product?: string | undefined
  /** Praesidium var root; the scratch env override still wins. */
  varRoot?: string | undefined
  /** Where metrics warnings go. Absent means silent (the asp CLI has no log). */
  warn?: UsageMetricWarning | undefined
}

export interface CreateUsageMetricsOptions {
  /** File prefix and the `component` field: `aspd`, `asp-cli`, `paths`, ... */
  component: string
  /** Defaults to the host product (see `usageMetricsProduct`). */
  product?: string | undefined
  /** Metrics dir; defaults to `resolveUsageMetricsDir()` at first write. */
  dir?: string | undefined
  /** Defaults to the host warn sink. */
  warn?: UsageMetricWarning | undefined
  maxDayFileBytes?: number | undefined
  /** Clock, for tests. */
  now?: (() => number) | undefined
}

// -- host identity -------------------------------------------------------------

let host: UsageMetricsHost = {}
let defaultProduct: string | undefined
let hostName: string | undefined

/** Set process-wide defaults. Called once by a process entry (aspd, asp CLI). */
export function configureUsageMetricsHost(next: UsageMetricsHost): void {
  host = { ...host, ...next }
}

const LABEL_MAX_CHARS = 64

function label(value: string): string {
  const cleaned = value.slice(0, LABEL_MAX_CHARS).replace(/[^A-Za-z0-9._:/@+-]/g, '_')
  return cleaned.length > 0 ? cleaned : 'unknown'
}

/** `<name>/<version>` from a caller-supplied string, line-safe and bounded; `unknown` if empty. */
export function usageMetricsLabel(value: string | undefined): string {
  const product = value?.trim().split(/\s/, 1)[0]
  return product ? label(product) : 'unknown'
}

function mainScript(): string | undefined {
  const script = process.argv[1]
  return script !== undefined && script.length > 0 && !script.startsWith('-') ? script : undefined
}

/**
 * Basename of the process's main bin or script, without extension (`asp`,
 * `aspd`, `acp-server`). Never a path or argv. Lets an in-process library
 * caller be attributed without the caller's cooperation.
 */
export function usageMetricsHostName(): string {
  if (hostName !== undefined) return hostName
  const script = mainScript() ?? process.execPath
  hostName = label(basename(script).replace(/\.(?:[cm]?[jt]s|tsx)$/, ''))
  return hostName
}

/**
 * The product to attribute rows to: the host's configured product, else
 * `<name>/<version>` of the package that owns the main script, else
 * `<host>/unknown`. Readable from any library without host initialization.
 */
export function usageMetricsProduct(): string {
  if (host.product !== undefined) return label(host.product)
  defaultProduct ??= discoverProduct()
  return defaultProduct
}

function discoverProduct(): string {
  try {
    const script = mainScript()
    if (script !== undefined) {
      let dir = dirname(realpathSync(script))
      for (let depth = 0; depth < 8; depth++) {
        try {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
            name?: unknown
            version?: unknown
          }
          if (typeof manifest.name === 'string' && typeof manifest.version === 'string') {
            return label(`${manifest.name}/${manifest.version}`)
          }
        } catch {
          // No manifest here; keep walking.
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    }
  } catch {
    // Compiled binaries and eval scripts have no readable main script.
  }
  return `${usageMetricsHostName()}/unknown`
}

/** `<var root>/state/agent-spaces/metrics`: scratch env, then host var root, then `~/praesidium/var`. */
export function resolveUsageMetricsDir(
  options: { env?: NodeJS.ProcessEnv | undefined; varRoot?: string | undefined } = {}
): string {
  const env = options.env ?? process.env
  const override = env[USAGE_METRICS_VAR_ROOT_ENV]?.trim()
  const varRoot =
    override || options.varRoot || host.varRoot || join(homedir(), 'praesidium', 'var')
  return join(varRoot, USAGE_METRICS_SUBDIR)
}

// -- compile mode (asp CLI invocation records) ---------------------------------

let compileMode: UsageCompileMode = 'none'

/** Note that this process compiled in-process or through aspd. Never throws. */
export function noteUsageCompile(mode: 'in-process' | 'aspd'): void {
  compileMode = compileMode === 'none' || compileMode === mode ? mode : 'mixed'
}

export function usageCompileMode(): UsageCompileMode {
  return compileMode
}

// -- writer -------------------------------------------------------------------

type Bucket = {
  kind: string
  key: UsageMetricKey
  count: number
  measures: Map<string, { sum: number; max: number }>
}

type Row = { day: string; line: string; bytes: number; droppedReport?: number }

const RESERVED = new Set(['v', 'kind', 'ts', 'component', 'product', 'host', 'pid', 'node'])

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

const round1 = (value: number): number => Math.round(value * 10) / 10

function cleanValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.slice(0, MAX_STRING_CHARS).replace(/\p{Cc}/gu, '_')
  }
  return value
}

function nodeName(): string {
  try {
    return hostname()
  } catch {
    return 'unknown'
  }
}

class UsageMetricsWriter implements UsageMetrics {
  private readonly component: string
  private readonly options: CreateUsageMetricsOptions
  private readonly now: () => number
  private readonly maxDayFileBytes: number
  private readonly node = nodeName()
  private readonly buckets = new Map<number, Map<string, Bucket>>()
  private pending: Row[] = []
  private exitHooks: ((exit: UsageMetricsExit) => void)[] = []
  private dir: string | undefined
  private dirReady = false
  private prunedDay: string | undefined
  private readonly daySizes = new Map<string, number>()
  private readonly capWarned = new Set<string>()
  private writeFailWarned = false
  private droppedTotal = 0
  private unreported = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private chain: Promise<void> = Promise.resolve()

  constructor(options: CreateUsageMetricsOptions) {
    this.options = options
    this.component = label(options.component)
    this.now = options.now ?? Date.now
    this.maxDayFileBytes = options.maxDayFileBytes ?? USAGE_METRICS_MAX_DAY_FILE_BYTES
  }

  record(kind: string, fields: Record<string, unknown>): void {
    try {
      if (this.pending.length >= MAX_PENDING_RECORDS) {
        this.drop(1)
        return
      }
      const nowMs = this.now()
      const ts = typeof fields['ts'] === 'string' ? fields['ts'] : new Date(nowMs).toISOString()
      const day = /^\d{4}-\d{2}-\d{2}T/.test(ts) ? ts.slice(0, 10) : utcDay(nowMs)
      this.pending.push(this.row(day, kind, ts, fields))
      this.schedule()
    } catch {
      this.drop(1)
    }
  }

  count(kind: string, key: UsageMetricKey, measures?: Record<string, number>): void {
    try {
      const minute = Math.floor(this.now() / MINUTE_MS)
      let minuteBuckets = this.buckets.get(minute)
      if (!minuteBuckets) {
        minuteBuckets = new Map()
        this.buckets.set(minute, minuteBuckets)
      }
      const id = `${kind}\u0000${JSON.stringify(Object.entries(key).sort(([a], [b]) => (a < b ? -1 : 1)))}`
      let bucket = minuteBuckets.get(id)
      if (!bucket) {
        if (minuteBuckets.size >= MAX_KEYS_PER_MINUTE) {
          this.drop(1)
          return
        }
        bucket = { kind, key: { ...key }, count: 0, measures: new Map() }
        minuteBuckets.set(id, bucket)
      }
      bucket.count += 1
      for (const [name, value] of Object.entries(measures ?? {})) {
        if (!Number.isFinite(value)) continue
        const stat = bucket.measures.get(name)
        if (stat) {
          stat.sum += value
          stat.max = Math.max(stat.max, value)
        } else {
          bucket.measures.set(name, { sum: value, max: value })
        }
      }
      this.schedule()
    } catch {
      this.drop(1)
    }
  }

  dropped(): number {
    return this.droppedTotal
  }

  onExit(fn: (exit: UsageMetricsExit) => void): void {
    this.exitHooks.push(fn)
  }

  runExitHooks(exit: UsageMetricsExit): void {
    const hooks = this.exitHooks
    this.exitHooks = []
    for (const hook of hooks) {
      try {
        hook(exit)
      } catch {
        // An exit hook's failure must not cost the other rows.
      }
    }
  }

  flush(): Promise<void> {
    this.clearTimer()
    this.chain = this.chain.then(() => this.drainAsync(true)).catch(() => {})
    return this.chain
  }

  flushSync(): void {
    this.clearTimer()
    try {
      const rows = this.take(true)
      if (rows.length === 0) return
      if (!this.prepareSync()) {
        this.failed(rows)
        return
      }
      for (const [day, dayRows] of byDay(rows)) this.appendSync(day, dayRows)
    } catch {
      // Exit path: nothing left to report to.
    }
  }

  // -- internals --------------------------------------------------------------

  private row(day: string, kind: string, ts: string, fields: Record<string, unknown>): Row {
    const body: Record<string, unknown> = {
      v: 1,
      kind,
      ts,
      component: this.component,
      product:
        this.options.product === undefined ? usageMetricsProduct() : label(this.options.product),
      host: usageMetricsHostName(),
      pid: process.pid,
      node: this.node,
    }
    for (const [name, value] of Object.entries(fields)) {
      if (!RESERVED.has(name) && value !== undefined) body[name] = cleanValue(value)
    }
    const line = `${JSON.stringify(body)}\n`
    return { day, line, bytes: Buffer.byteLength(line) }
  }

  /** Completed minutes (or all of them), then plain records, then the drop report. */
  private take(all: boolean): Row[] {
    const rows: Row[] = []
    const currentMinute = Math.floor(this.now() / MINUTE_MS)
    for (const [minute, minuteBuckets] of [...this.buckets].sort(([a], [b]) => a - b)) {
      if (!all && minute >= currentMinute) continue
      this.buckets.delete(minute)
      const startMs = minute * MINUTE_MS
      const ts = new Date(startMs).toISOString()
      for (const bucket of minuteBuckets.values()) {
        const fields: Record<string, unknown> = { ...bucket.key, count: bucket.count }
        for (const [name, stat] of bucket.measures) {
          fields[`${name}Sum`] = round1(stat.sum)
          fields[`${name}Max`] = round1(stat.max)
        }
        rows.push(this.row(utcDay(startMs), bucket.kind, ts, fields))
      }
    }
    rows.push(...this.pending)
    this.pending = []
    if (this.unreported > 0) {
      const nowMs = this.now()
      const report = this.row(utcDay(nowMs), 'metrics.dropped', new Date(nowMs).toISOString(), {
        count: this.unreported,
      })
      rows.push({ ...report, droppedReport: this.unreported })
    }
    return rows
  }

  private drop(rows: number): void {
    this.droppedTotal += rows
    this.unreported += rows
  }

  private warn(event: UsageMetricWarningEvent, data: Record<string, unknown>): void {
    try {
      ;(this.options.warn ?? host.warn)?.(event, { component: this.component, ...data })
    } catch {
      // The warning sink is observational too.
    }
  }

  private schedule(): void {
    if (this.timer !== undefined) return
    const delay = MINUTE_MS - (Date.now() % MINUTE_MS) + 100
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.chain = this.chain
        .then(() => this.drainAsync(false))
        .catch(() => {})
        .then(() => {
          if (this.buckets.size > 0 || this.pending.length > 0) this.schedule()
        })
    }, delay)
    this.timer.unref?.()
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  private metricsDir(): string {
    this.dir ??= this.options.dir ?? resolveUsageMetricsDir()
    return this.dir
  }

  private failed(rows: Row[], error?: unknown): void {
    this.dirReady = false
    let lost = 0
    for (const row of rows) if (row.droppedReport === undefined) lost += 1
    this.drop(lost)
    if (!this.writeFailWarned) {
      this.writeFailWarned = true
      this.warn('metrics.write_failed', {
        dir: this.metricsDir(),
        dropped: lost,
        ...(error === undefined ? {} : { error: String(error) }),
      })
    }
  }

  private written(rows: Row[]): void {
    this.writeFailWarned = false
    for (const row of rows)
      if (row.droppedReport !== undefined) this.unreported -= row.droppedReport
  }

  /** Which rows fit under the day cap; the rest are dropped (reported once per day). */
  private fit(
    day: string,
    size: number,
    rows: Row[]
  ): { chunk: string; bytes: number; kept: Row[] } {
    let chunk = ''
    let bytes = 0
    const kept: Row[] = []
    let capped = 0
    for (const row of rows) {
      if (size + bytes + row.bytes > this.maxDayFileBytes) {
        if (row.droppedReport === undefined) capped += 1
        continue
      }
      chunk += row.line
      bytes += row.bytes
      kept.push(row)
    }
    if (capped > 0) {
      this.drop(capped)
      if (!this.capWarned.has(day)) {
        this.capWarned.add(day)
        this.warn('metrics.cap_reached', {
          file: this.file(day),
          maxBytes: this.maxDayFileBytes,
          dropped: capped,
        })
      }
    }
    return { chunk, bytes, kept }
  }

  private file(day: string): string {
    return join(this.metricsDir(), `${this.component}-${day}.ndjson`)
  }

  private pruneCandidates(names: string[], today: string): string[] {
    const cutoff = utcDay(
      Date.parse(`${today}T00:00:00.000Z`) - (USAGE_METRICS_RETENTION_DAYS - 1) * DAY_MS
    )
    const pattern = new RegExp(
      `^${this.component.replace(/[.+]/g, '\\$&')}-(\\d{4}-\\d{2}-\\d{2})\\.ndjson$`
    )
    return names.filter((name) => {
      const date = pattern.exec(name)?.[1]
      return date !== undefined && date < cutoff
    })
  }

  private prepareSync(): boolean {
    try {
      const dir = this.metricsDir()
      if (!this.dirReady) {
        mkdirSync(dir, { recursive: true })
        this.dirReady = true
      }
      const today = utcDay(this.now())
      if (this.prunedDay !== today) {
        this.prunedDay = today
        try {
          for (const name of this.pruneCandidates(readdirSync(dir), today))
            unlinkSync(join(dir, name))
        } catch (error) {
          this.warn('metrics.prune_failed', { dir, error: String(error) })
        }
      }
      return true
    } catch {
      return false
    }
  }

  private async prepareAsync(): Promise<boolean> {
    try {
      const dir = this.metricsDir()
      if (!this.dirReady) {
        await mkdir(dir, { recursive: true })
        this.dirReady = true
      }
      const today = utcDay(this.now())
      if (this.prunedDay !== today) {
        this.prunedDay = today
        try {
          for (const name of this.pruneCandidates(await readdir(dir), today)) {
            await unlink(join(dir, name))
          }
        } catch (error) {
          this.warn('metrics.prune_failed', { dir, error: String(error) })
        }
      }
      return true
    } catch {
      return false
    }
  }

  private appendSync(day: string, rows: Row[]): void {
    const file = this.file(day)
    let size = this.daySizes.get(day)
    if (size === undefined) {
      try {
        size = statSync(file).size
      } catch {
        size = 0
      }
    }
    const { chunk, bytes, kept } = this.fit(day, size, rows)
    if (bytes === 0) return
    try {
      appendFileSync(file, chunk)
      this.daySizes.set(day, size + bytes)
      this.written(kept)
    } catch (error) {
      this.daySizes.delete(day)
      this.failed(kept, error)
    }
  }

  private async drainAsync(all: boolean): Promise<void> {
    const rows = this.take(all)
    if (rows.length === 0) return
    if (!(await this.prepareAsync())) {
      this.failed(rows)
      return
    }
    for (const [day, dayRows] of byDay(rows)) {
      const file = this.file(day)
      let size = this.daySizes.get(day)
      if (size === undefined) {
        size = await stat(file).then(
          (st) => st.size,
          () => 0
        )
      }
      const { chunk, bytes, kept } = this.fit(day, size, dayRows)
      if (bytes === 0) continue
      try {
        await appendFile(file, chunk)
        this.daySizes.set(day, size + bytes)
        this.written(kept)
      } catch (error) {
        this.daySizes.delete(day)
        this.failed(kept, error)
      }
    }
  }
}

function byDay(rows: Row[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>()
  for (const row of rows) {
    const list = out.get(row.day)
    if (list) list.push(row)
    else out.set(row.day, [row])
  }
  return out
}

// -- process lifecycle --------------------------------------------------------

const liveWriters = new Set<UsageMetricsWriter>()
const componentWriters = new Map<string, UsageMetricsWriter>()
const SIGNAL_NUMBERS: Partial<Record<NodeJS.Signals, number>> = { SIGINT: 2, SIGTERM: 15 }
let lifecycleInstalled = false

function finalize(exit: UsageMetricsExit): void {
  for (const writer of liveWriters) writer.runExitHooks(exit)
  for (const writer of liveWriters) writer.flushSync()
}

function installLifecycle(): void {
  if (lifecycleInstalled) return
  lifecycleInstalled = true
  process.on('exit', (code) => finalize({ code: typeof code === 'number' ? code : 0 }))
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    const onSignal = (): void => {
      // A process that handles the signal itself (aspd's graceful retire)
      // exits through `exit`, which flushes. Otherwise keep the default: flush,
      // then die by the same signal.
      if (process.listenerCount(signal) > 1) return
      finalize({ code: 128 + (SIGNAL_NUMBERS[signal] ?? 0), signal })
      process.removeListener(signal, onSignal)
      process.kill(process.pid, signal)
    }
    process.on(signal, onSignal)
  }
}

/** A writer for one component, flushed at process exit and on SIGTERM/SIGINT. */
export function createUsageMetrics(options: CreateUsageMetricsOptions): UsageMetrics {
  const writer = new UsageMetricsWriter(options)
  try {
    installLifecycle()
    liveWriters.add(writer)
  } catch {
    // Without lifecycle hooks the minute timer still flushes.
  }
  return writer
}

/** The process-wide writer for `component`, using the host's product, var root and warn sink. */
export function usageMetrics(component: string): UsageMetrics {
  let writer = componentWriters.get(component)
  if (!writer) {
    writer = createUsageMetrics({ component }) as UsageMetricsWriter
    componentWriters.set(component, writer)
  }
  return writer
}

/** Flush every writer in this process. Never rejects. */
export async function flushUsageMetrics(): Promise<void> {
  await Promise.all([...liveWriters].map((writer) => writer.flush()))
}
