/**
 * Shared bun test preload, wired by every workspace bunfig.toml (T-11824).
 * Isolates ASP usage metrics to a scratch root and fails the run if a test, or
 * a process it spawned, wrote to the node's real metrics files.
 */
import { afterAll } from 'bun:test'
import {
  PRODUCTION_USAGE_METRICS_DIR,
  isolateUsageMetrics,
  ownedUsageMetricsRows,
  recordTestPids,
  snapshotUsageMetrics,
} from './lib/usage-metrics-isolation.ts'

const childPids = isolateUsageMetrics()
const snapshot = snapshotUsageMetrics()

afterAll(() => {
  const pids = new Set([process.pid, ...childPids])
  recordTestPids(childPids)
  const owned = ownedUsageMetricsRows(snapshot, pids)
  if (owned.length > 0) {
    throw new Error(
      `test run wrote ${owned.length} row(s) to production usage metrics in ${PRODUCTION_USAGE_METRICS_DIR}: ${JSON.stringify(owned.slice(0, 3))}`
    )
  }
})
