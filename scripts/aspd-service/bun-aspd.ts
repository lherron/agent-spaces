/**
 * Bun aspd's lifecycle on its socket (the public one, or the private one
 * behind raspd): a detached daemon by default, or the one process of a
 * per-user launchd job once the namespace is supervised.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { inspectRelease } from '../asp-release.ts'
import {
  RETIRE_TIMEOUT_MS,
  awaitPidExit,
  awaitServing,
  pidAlive,
  readback,
  runningProcess,
  spawnDetached,
} from './daemon-process.ts'
import {
  bootoutIfLoaded,
  bootstrapJob,
  kickstart,
  launchdLoaded,
  launchdPid,
  renderLaunchdScript,
  writeLaunchScript,
  writeLaunchdPlist,
} from './launchd.ts'
import {
  type ActiveSelection,
  type LaunchdSupervisor,
  type NamespacePaths,
  type RunningRecord,
  type ServiceConfig,
  bunSocketPath,
  fail,
  selectedRelease,
  serviceEnv,
  serviceLogPaths,
  writeJsonAtomic,
} from './namespace.ts'

/** A pid counts as our daemon only if it is still executing the recorded release. */
export function runningBun(p: NamespacePaths): RunningRecord | undefined {
  return runningProcess(p.running, 'aspd')
}

/** Start (or confirm) Bun aspd on the selected release. */
export async function startBun(
  p: NamespacePaths,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const active = selectedRelease(p)
  const existing = runningBun(p)
  if (existing !== undefined) {
    if (existing.releaseId !== active.releaseId) {
      fail(
        `running ${existing.releaseId} differs from selected ${active.releaseId}; activate instead`
      )
    }
    return { alreadyRunning: existing, serving: await readback(bunSocketPath(config)) }
  }
  const inspection = inspectRelease(active.releasePath)
  const aspd = inspection.executableResolution.aspd
  if (aspd === undefined || !aspd.embeddedIdentity) {
    fail(`release ${active.releaseId} does not contain an identity-bound aspd`)
  }

  if (config.supervisor !== undefined) return startSupervised(p, config, active)
  const env = serviceEnv(config)
  const startedAt = new Date().toISOString()
  const logDir = serviceLogPaths(p.ns, config).dir
  mkdirSync(logDir, { recursive: true, mode: 0o700 })
  const logPath = join(logDir, `aspd-${active.releaseId}-${startedAt.replace(/[:.]/g, '')}.log`)
  const pid = spawnDetached('aspd', aspd.launcher, ['serve', '--socket', bunSocketPath(config)], {
    cwd: p.ns,
    env,
    logPath,
  })
  const record: RunningRecord = {
    pid,
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    startedAt,
    logPath,
  }
  writeJsonAtomic(p.running, record)

  const serving = await awaitServing(bunSocketPath(config), active.releaseId, () => {
    if (!pidAlive(pid)) fail(`aspd did not become ready; see ${logPath}`)
  })
  return { started: record, serving, readyAt: new Date().toISOString() }
}

/** Retire Bun aspd: SIGTERM drains it, SIGKILL after the retire budget. */
export async function stopBun(
  p: NamespacePaths,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  if (config.supervisor !== undefined) return stopSupervised(p, config)
  const record = runningBun(p)
  if (record === undefined) {
    rmSync(p.running, { force: true })
    return { stopped: false, reason: 'not running' }
  }
  const signalledAt = new Date().toISOString()
  process.kill(record.pid, 'SIGTERM')
  const deadline = Date.now() + RETIRE_TIMEOUT_MS
  let forced = false
  while (pidAlive(record.pid)) {
    if (Date.now() > deadline) {
      process.kill(record.pid, 'SIGKILL')
      forced = true
    }
    await Bun.sleep(50)
  }
  rmSync(p.running, { force: true })
  return {
    stopped: true,
    releaseId: record.releaseId,
    pid: record.pid,
    signalledAt,
    exitedAt: new Date().toISOString(),
    forced,
    socketAfterStop: await readback(bunSocketPath(config)),
  }
}

/**
 * Write the job, record it in the config, then start it: the namespace now
 * belongs to launchd. The caller has already retired any unsupervised daemon.
 */
export async function superviseBun(
  p: NamespacePaths,
  supervised: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  writeBunLaunchScript(p, supervised, active)
  writeLaunchdPlist(bunJob(p, supervised), serviceLogPaths(p.ns, supervised).supervisor)
  writeJsonAtomic(p.config, supervised)
  return startSupervised(p, supervised, active)
}

/** The Bun job, always run from this namespace's own launch script. */
function bunJob(p: NamespacePaths, config: ServiceConfig): LaunchdSupervisor {
  return { ...(config.supervisor as LaunchdSupervisor), launchScript: p.launchScript }
}

/** Regenerate the launch script for the current selection. */
function writeBunLaunchScript(
  p: NamespacePaths,
  config: ServiceConfig,
  active: ActiveSelection
): void {
  const logs = serviceLogPaths(p.ns, config)
  mkdirSync(logs.dir, { recursive: true, mode: 0o700 })
  writeLaunchScript(
    bunJob(p, config),
    renderLaunchdScript({
      ns: p.ns,
      socketPath: bunSocketPath(config),
      releaseId: active.releaseId,
      releasePath: active.releasePath,
      env: serviceEnv(config),
      logPath: logs.supervisor,
      requestLogPath: logs.request,
    })
  )
}

/** Start (or confirm) the supervised daemon on the current selection. */
async function startSupervised(
  p: NamespacePaths,
  config: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  writeBunLaunchScript(p, config, active)
  if (!launchdLoaded(supervisor.label)) {
    // Every load rewrites and re-adopts the plist, so a load always carries the
    // configured log paths and adoption, even for a plist written before either.
    writeLaunchdPlist(bunJob(p, config), serviceLogPaths(p.ns, config).supervisor)
    await bootstrapJob(supervisor)
  } else if (launchdPid(supervisor.label) === undefined) {
    kickstart(supervisor.label, false)
  }
  const serving = await awaitServing(bunSocketPath(config), active.releaseId)
  return {
    supervisor,
    launchdPid: launchdPid(supervisor.label) ?? null,
    running: runningBun(p) ?? null,
    serving,
    readyAt: new Date().toISOString(),
  }
}

/** Retire the supervised daemon and start the current selection through launchd. */
export async function restartSupervisedBun(
  p: NamespacePaths,
  config: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  if (!launchdLoaded(supervisor.label)) return startSupervised(p, config, active)
  writeBunLaunchScript(p, config, active)
  const previousPid = launchdPid(supervisor.label)
  const signalledAt = new Date().toISOString()
  kickstart(supervisor.label, true)
  await awaitPidExit(previousPid)
  const retiredAt = new Date().toISOString()
  const serving = await awaitServing(bunSocketPath(config), active.releaseId)
  const pid = launchdPid(supervisor.label)
  if (pid === undefined || pid === previousPid) fail('launchd did not start a new aspd process')
  return {
    supervisor,
    previousPid: previousPid ?? null,
    signalledAt,
    retiredAt,
    launchdPid: pid,
    running: runningBun(p) ?? null,
    serving,
    readyAt: new Date().toISOString(),
  }
}

async function stopSupervised(
  p: NamespacePaths,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  const pid = launchdPid(supervisor.label)
  const signalledAt = new Date().toISOString()
  bootoutIfLoaded(supervisor.label)
  await awaitPidExit(pid)
  rmSync(p.running, { force: true })
  return {
    stopped: pid !== undefined,
    supervisor,
    pid: pid ?? null,
    signalledAt,
    exitedAt: new Date().toISOString(),
    socketAfterStop: await readback(bunSocketPath(config)),
  }
}
