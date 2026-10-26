/**
 * Keep test runs out of the node's real ASP usage metrics (T-11824).
 *
 * Every test process, and every process it spawns, resolves the metrics var
 * root to a per-run scratch dir unless a test sets one deliberately:
 * - runners (`just verify`, test-packages, run-tests-no-git-clone) set
 *   ASP_USAGE_METRICS_VAR_ROOT once for the whole run;
 * - the shared bun test preload (scripts/test-preload.ts, wired by each
 *   workspace bunfig.toml) sets it for a direct `bun test`, and injects it into
 *   every child env a test builds by hand (Bun's node:child_process routes
 *   through Bun.spawn/spawnSync, so patching those two covers all spawn APIs).
 *
 * The guard is HRC's "suite-owned production writes" idea: snapshot the real
 * metrics files, and after the tests fail on any appended row written by this
 * process or a child it spawned. Rows other processes append (live aspd, real
 * agents) are normal and ignored.
 */
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { USAGE_METRICS_SUBDIR, USAGE_METRICS_VAR_ROOT_ENV } from 'spaces-config/usage-metrics'

/**
 * Where an un-isolated writer in this process tree would write: the writer's
 * own default (`~/praesidium/var/...` from HOME), so the guard watches exactly
 * the files a leak would reach.
 */
export const PRODUCTION_USAGE_METRICS_DIR = join(
  homedir(),
  'praesidium',
  'var',
  USAGE_METRICS_SUBDIR
)

/** `env` with a fresh scratch metrics var root, unless it already names one. */
export function withScratchUsageMetrics(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env[USAGE_METRICS_VAR_ROOT_ENV]) return env
  return {
    ...env,
    [USAGE_METRICS_VAR_ROOT_ENV]: mkdtempSync(join(tmpdir(), 'asp-test-metrics-')),
  }
}

type SpawnOptions = { env?: Record<string, string | undefined> | undefined }

/**
 * Point this process at a scratch metrics root and inject that root into every
 * child env built by hand. Returns the pids of children spawned from here on.
 */
export function isolateUsageMetrics(): Set<number> {
  const scratch = withScratchUsageMetrics(process.env)[USAGE_METRICS_VAR_ROOT_ENV] as string
  process.env[USAGE_METRICS_VAR_ROOT_ENV] = scratch
  const childPids = new Set<number>()
  const bun = Bun as unknown as Record<'spawn' | 'spawnSync', (...args: unknown[]) => unknown>
  for (const name of ['spawn', 'spawnSync'] as const) {
    const original = bun[name]
    bun[name] = (...args: unknown[]) => {
      // Bun.spawn(cmd[], options?) or Bun.spawn({ cmd, ...options }).
      const options = (Array.isArray(args[0]) ? args[1] : args[0]) as SpawnOptions | undefined
      if (options?.env !== undefined && options.env[USAGE_METRICS_VAR_ROOT_ENV] === undefined) {
        options.env = { ...options.env, [USAGE_METRICS_VAR_ROOT_ENV]: scratch }
      }
      const child = original(...args) as { pid?: number }
      if (typeof child?.pid === 'number') childPids.add(child.pid)
      return child
    }
  }
  return childPids
}

export type MetricsSnapshot = Map<string, { ino: number; size: number }>

export function snapshotUsageMetrics(dir = PRODUCTION_USAGE_METRICS_DIR): MetricsSnapshot {
  const snapshot: MetricsSnapshot = new Map()
  if (!existsSync(dir)) return snapshot
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.ndjson')) continue
    const stats = statSync(join(dir, name))
    snapshot.set(name, { ino: stats.ino, size: stats.size })
  }
  return snapshot
}

/** Every row appended since `snapshot`, tagged with its file. */
export function appendedUsageMetricsRows(
  snapshot: MetricsSnapshot,
  dir = PRODUCTION_USAGE_METRICS_DIR
): Record<string, unknown>[] {
  const appended: Record<string, unknown>[] = []
  for (const [name, after] of snapshotUsageMetrics(dir)) {
    const before = snapshot.get(name)
    const offset = before && before.ino === after.ino && before.size <= after.size ? before.size : 0
    if (after.size === offset) continue
    const buffer = Buffer.alloc(after.size - offset)
    const fd = openSync(join(dir, name), 'r')
    try {
      readSync(fd, buffer, 0, buffer.length, offset)
    } finally {
      closeSync(fd)
    }
    for (const line of buffer.toString('utf8').split('\n')) {
      try {
        appended.push({ file: name, ...(JSON.parse(line) as Record<string, unknown>) })
      } catch {
        // A foreign append can straddle either observation.
      }
    }
  }
  return appended
}

/** Rows appended since `snapshot` whose pid is one of `pids`. */
export function ownedUsageMetricsRows(
  snapshot: MetricsSnapshot,
  pids: ReadonlySet<number>,
  dir = PRODUCTION_USAGE_METRICS_DIR
): Record<string, unknown>[] {
  return appendedUsageMetricsRows(snapshot, dir).filter(
    (row) => typeof row['pid'] === 'number' && pids.has(row['pid'])
  )
}

/** Record this process's pids under the run's scratch root, for a run-level audit. */
export function recordTestPids(pids: ReadonlySet<number>): void {
  try {
    const root = process.env[USAGE_METRICS_VAR_ROOT_ENV]
    if (!root) return
    const dir = join(root, 'test-pids')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${process.pid}.json`), JSON.stringify([process.pid, ...pids]))
  } catch {
    // The audit trail is best-effort; the in-process guard is the gate.
  }
}
