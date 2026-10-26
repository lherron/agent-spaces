/**
 * The front door (T-11835, docs/proposals/aspd-rust-front-door.md): raspd from
 * the selected release on the public socket, forwarding to Bun aspd on
 * `<run>/aspd-bun.sock`. Detached, or its own launchd job when supervised.
 */
import { mkdirSync, rmSync } from 'node:fs'
import { inspectRelease } from '../asp-release.ts'
import {
  awaitFrontDoor,
  awaitPidExit,
  pidAlive,
  runningProcess,
  spawnDetached,
  versionOf,
} from './daemon-process.ts'
import {
  bootoutIfLoaded,
  bootstrapJob,
  launchAgentJob,
  launchdPid,
  renderLaunchdScript,
  writeLaunchScript,
  writeLaunchdPlist,
} from './launchd.ts'
import {
  type ActiveSelection,
  type FrontDoor,
  type LaunchdSupervisor,
  type NamespacePaths,
  type RunningRecord,
  type ServiceConfig,
  fail,
  serviceEnv,
  serviceLogPaths,
  writeJsonAtomic,
} from './namespace.ts'

/** The raspd process recorded for this namespace, if it is still raspd from that release. */
function runningRaspd(p: NamespacePaths): RunningRecord | undefined {
  return runningProcess(p.raspdRunning, 'raspd')
}

/** raspd's launchd job in a supervised, fronted namespace. */
export function raspdJob(p: NamespacePaths, config: ServiceConfig): LaunchdSupervisor {
  return launchAgentJob((config.frontDoor as FrontDoor).label, p.raspdLaunchScript)
}

/** Start raspd from `active` on the public socket, in front of Bun's socket. */
export async function startRaspd(
  p: NamespacePaths,
  config: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  const front = config.frontDoor as FrontDoor
  const existing = runningRaspd(p)
  if (existing !== undefined && existing.releaseId === active.releaseId) {
    return { alreadyRunning: existing, serving: await versionOf(config.socketPath) }
  }
  if (existing !== undefined) await stopRaspd(p, config)
  const raspd = inspectRelease(active.releasePath).executableResolution.raspd
  if (raspd === undefined) fail(`release ${active.releaseId} does not contain raspd`)
  const logs = serviceLogPaths(p.ns, config)
  mkdirSync(logs.dir, { recursive: true, mode: 0o700 })
  const args = ['--upstream', front.bunSocketPath]

  if (config.supervisor !== undefined) {
    const supervisor = raspdJob(p, config)
    writeLaunchScript(
      supervisor,
      renderLaunchdScript({
        ns: p.ns,
        socketPath: config.socketPath,
        releaseId: active.releaseId,
        releasePath: active.releasePath,
        env: serviceEnv(config),
        logPath: logs.raspdSupervisor,
        requestLogPath: logs.raspdRequest,
        program: 'raspd',
        extraArgs: args,
      })
    )
    bootoutIfLoaded(supervisor.label)
    writeLaunchdPlist(supervisor, logs.raspdSupervisor)
    await bootstrapJob(supervisor)
    const serving = await awaitFrontDoor(config.socketPath, active.releaseId)
    return { supervisor, launchdPid: launchdPid(supervisor.label) ?? null, serving }
  }

  const startedAt = new Date().toISOString()
  const pid = spawnDetached(
    'raspd',
    raspd.launcher,
    ['serve', '--socket', config.socketPath, ...args, '--log', logs.raspdRequest],
    { cwd: p.ns, env: serviceEnv(config), logPath: logs.raspdSupervisor }
  )
  const record: RunningRecord = {
    pid,
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    startedAt,
    logPath: logs.raspdSupervisor,
  }
  writeJsonAtomic(p.raspdRunning, record)
  const serving = await awaitFrontDoor(config.socketPath, active.releaseId, () => {
    if (!pidAlive(pid)) fail(`raspd did not become ready; see ${logs.raspdSupervisor}`)
  })
  return { started: record, serving, readyAt: new Date().toISOString() }
}

/** Retire raspd (SIGTERM drains it) and wait for it to exit. */
export async function stopRaspd(
  p: NamespacePaths,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const signalledAt = new Date().toISOString()
  if (config.supervisor !== undefined && config.frontDoor !== undefined) {
    const supervisor = raspdJob(p, config)
    const pid = launchdPid(supervisor.label)
    bootoutIfLoaded(supervisor.label)
    await awaitPidExit(pid)
    rmSync(p.raspdRunning, { force: true })
    return { stopped: pid !== undefined, supervisor, pid: pid ?? null, signalledAt }
  }
  const record = runningRaspd(p)
  if (record === undefined) {
    rmSync(p.raspdRunning, { force: true })
    return { stopped: false, reason: 'not running' }
  }
  process.kill(record.pid, 'SIGTERM')
  await awaitPidExit(record.pid)
  rmSync(p.raspdRunning, { force: true })
  return { stopped: true, pid: record.pid, signalledAt, exitedAt: new Date().toISOString() }
}

/** Which process answers each socket, direct or fronted. */
export async function frontDoorStatus(
  p: NamespacePaths,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const publicVersion = await versionOf(config.socketPath)
  const front = publicVersion?.['frontDoor'] ?? null
  if (config.frontDoor === undefined) {
    return { mode: 'direct', bunSocket: config.socketPath, publicFrontDoor: front }
  }
  const bunVersion = await versionOf(config.frontDoor.bunSocketPath)
  return {
    mode: 'fronted',
    publicSocket: config.socketPath,
    bunSocket: config.frontDoor.bunSocketPath,
    raspd: runningRaspd(p) ?? null,
    raspdLaunchdPid:
      config.supervisor !== undefined ? (launchdPid(config.frontDoor.label) ?? null) : null,
    publicFrontDoor: front,
    publicRelease: publicVersion?.['release'] ?? null,
    bunAnswering: bunVersion !== undefined,
    bunRelease: bunVersion?.['release'] ?? null,
  }
}
