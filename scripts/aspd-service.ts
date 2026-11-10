#!/usr/bin/env bun
/**
 * Isolated `aspd` service lifecycle (T-08539, docs/aspd.md).
 *
 * One explicit namespace root holds installed releases, the selected
 * (activated) release, the stable socket and daemon state. Installation
 * (`just install-asp-release … <ns>/releases`) never selects anything;
 * activation retires the running daemon, records the selection and starts the
 * selected release on the same socket, and is complete only when the new
 * daemon answers `aspc.hello` with the target identity.
 *
 * Workers are never touched: they are not children of this lifecycle.
 *
 * Supervision: by default `start` spawns a detached daemon. `supervise` hands
 * the service lifetime to a per-user launchd job instead (aspd-service/launchd.ts);
 * the same verbs then act through launchd, which owns the one `aspd` process
 * (no second supervisor).
 *
 * Front door (T-11835, docs/proposals/aspd-rust-front-door.md): a fronted
 * namespace runs raspd from the selected release on the public socket and Bun
 * aspd on `<run>/aspd-bun.sock`. The role is recorded in the service config,
 * so Bun's listen socket follows it; every verb (start, stop, restart,
 * activate, status) acts on both processes. `front-door-enable` and
 * `front-door-disable` switch the role; rollback is the disable.
 *
 * Sole (T-13018 section 4): raspd alone on the public socket, started without
 * `--upstream`; no Bun aspd process, job or socket belongs to the namespace.
 * `sole-enable` moves fronted to sole; `front-door-enable` moves sole back to
 * fronted, which is the rollback. Every other verb keeps the role it finds.
 *
 * This file holds the verbs, which pair the two roles; each role's lifecycle
 * lives in aspd-service/bun-aspd.ts and aspd-service/raspd.ts.
 */
import { appendFileSync, existsSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { inspectRelease } from './asp-release.ts'
import {
  restartSupervisedBun,
  runningBun,
  startBun,
  stopBun,
  superviseBun,
} from './aspd-service/bun-aspd.ts'
import { readback } from './aspd-service/daemon-process.ts'
import {
  assertLaunchdLabel,
  launchAgentJob,
  launchdPid,
  prepareActivatedExecutables,
} from './aspd-service/launchd.ts'
import {
  ACTIVE_SCHEMA,
  type ActiveSelection,
  type NamespacePaths,
  type ServiceConfig,
  type ServiceRole,
  fail,
  initNamespace,
  namespacePaths,
  readJson,
  requireConfig,
  selectedRelease,
  serviceRole,
  setLogDir,
  writeJsonAtomic,
} from './aspd-service/namespace.ts'
import {
  assertSoleRelease,
  frontDoorStatus,
  raspdJob,
  startRaspd,
  stopRaspd,
} from './aspd-service/raspd.ts'
import { supportsFixedExecutableReleaseRoot } from './aspd-service/release-compatibility.ts'
import { pruneReleases } from './aspd-service/release-retention.ts'

const RASPD_DEFAULT_LABEL = 'com.praesidium.raspd'
const BUN_FRONTED_SOCKET = 'aspd-bun.sock'

/** Start Bun aspd and, when fronted, raspd in front of it; sole starts raspd alone. */
async function start(p: NamespacePaths, config: ServiceConfig): Promise<Record<string, unknown>> {
  const role = serviceRole(config)
  if (role === 'sole') return { raspd: await startRaspd(p, config, selectedRelease(p)) }
  const bun = await startBun(p, config)
  if (role === 'direct') return bun
  return { bun, raspd: await startRaspd(p, config, selectedRelease(p)) }
}

/** Stop raspd (when fronted or sole) and then Bun aspd (when there is one). */
async function stop(p: NamespacePaths, config: ServiceConfig): Promise<Record<string, unknown>> {
  const role = serviceRole(config)
  if (role === 'direct') return stopBun(p, config)
  const raspd = await stopRaspd(p, config)
  if (role === 'sole') return { raspd }
  return { raspd, bun: await stopBun(p, config) }
}

/** A supervised direct namespace restarts through launchd; anything else stops and starts. */
async function restart(p: NamespacePaths, config: ServiceConfig): Promise<Record<string, unknown>> {
  if (serviceRole(config) === 'direct' && config.supervisor !== undefined) {
    return restartSupervisedBun(p, config, selectedRelease(p))
  }
  return { stop: await stop(p, config), start: await start(p, config) }
}

/**
 * Hand the service lifetime to a per-user launchd job. Requires a selection.
 * An unsupervised daemon is retired first so there is never a second owner.
 */
async function supervise(nsInput: string, label: string): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  const active = selectedRelease(p)
  assertLaunchdLabel(label)
  const supervisor = launchAgentJob(label, p.launchScript)
  const previous = config.supervisor
  if (previous !== undefined && previous.label !== label) {
    fail(`namespace is already supervised by ${previous.label}`)
  }
  const retired =
    previous === undefined
      ? await stop(p, config)
      : { stopped: false, reason: 'already supervised' }
  const supervised: ServiceConfig = { ...config, supervisor }
  const role = serviceRole(supervised)
  if (role === 'sole') {
    // No Bun job in a sole namespace: record the supervisor (its label is
    // where front-door-enable puts Bun's job back) and start raspd's job.
    writeJsonAtomic(p.config, supervised)
    return {
      supervised: supervisor,
      retired,
      started: { raspd: await startRaspd(p, supervised, active) },
    }
  }
  const started = await superviseBun(p, supervised, active)
  if (role === 'direct') return { supervised: supervisor, retired, started }
  return {
    supervised: supervisor,
    retired,
    started: { bun: started, raspd: await startRaspd(p, supervised, active) },
  }
}

/** Prune old releases after a successful activation; never fails the activation. */
function retainReleases(releasesDir: string, selection: ActiveSelection): unknown {
  try {
    return pruneReleases(releasesDir, {
      activeReleaseId: selection.releaseId,
      previousReleaseId: selection.previousReleaseId,
    })
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

async function activate(nsInput: string, releaseId: string): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  const releasePath = realpathSync(join(p.releases, releaseId))
  const inspection = inspectRelease(releasePath)
  if (inspection.executableResolution.aspd?.embeddedIdentity !== true) {
    fail(`release ${releaseId} does not contain an identity-bound aspd`)
  }
  const role = serviceRole(config)
  const fronted = role !== 'direct'
  if (fronted && inspection.executableResolution.raspd === undefined) {
    fail(`namespace is ${role} and release ${releaseId} does not contain raspd`)
  }
  // Before anything stops: a sole namespace runs only a raspd that knows sole mode.
  if (role === 'sole') assertSoleRelease(inspection, releaseId)
  const previous = readJson<ActiveSelection>(p.active)
  const beganAt = new Date().toISOString()
  const useFixedExecutables = supportsFixedExecutableReleaseRoot(inspection)
  if (!useFixedExecutables) {
    appendFileSync(
      p.activations,
      `${JSON.stringify({
        event: 'stable-exec.legacy-fallback',
        message: 'release predates stable exec and runs from its release dir',
        releaseId,
        releasePath,
      })}\n`
    )
  }
  // A fronted namespace retires raspd first and starts it last, on the newly
  // selected release, so it never fronts a Bun from another release.
  const raspdRetired = fronted ? await stopRaspd(p, config) : undefined
  // Retire, select, start. Under supervision `bootout` unloads the job, so
  // KeepAlive cannot respawn anything while the selection changes; `bootstrap`
  // then starts only the newly selected release. A sole namespace has no Bun.
  const retired = role === 'sole' ? undefined : await stopBun(p, config)
  // Prepare and sign fixed paths while both daemons are down, before either
  // launch script can pair a new release root with a stale executable.
  // The immutable release remains untouched for digest verification.
  const stableExecutables = prepareActivatedExecutables(
    p,
    { releasePath },
    {
      ...config,
      capabilities: inspection.capabilities,
    }
  )
  const selection: ActiveSelection = {
    schemaVersion: ACTIVE_SCHEMA,
    releaseId,
    releasePath,
    activatedAt: new Date().toISOString(),
    previousReleaseId: previous?.releaseId ?? null,
  }
  writeJsonAtomic(p.active, selection)
  const started = role === 'sole' ? undefined : await startBun(p, config)
  const result = {
    activation: selection,
    role,
    beganAt,
    ...(role === 'sole' ? {} : { retired, started }),
    executableMode: useFixedExecutables ? 'fixed' : 'legacy-release',
    ...(stableExecutables !== undefined ? { stableExecutables } : {}),
    ...(fronted ? { raspdRetired, raspdStarted: await startRaspd(p, config, selection) } : {}),
    retention: retainReleases(p.releases, selection),
    completedAt: new Date().toISOString(),
  }
  appendFileSync(p.activations, `${JSON.stringify(result)}\n`)
  return result
}

async function status(p: NamespacePaths, config: ServiceConfig): Promise<Record<string, unknown>> {
  const installed = existsSync(p.releases)
    ? readdirSync(p.releases)
        .filter((entry) => entry.startsWith('asp-'))
        .sort()
    : []
  const selected = readJson<ActiveSelection>(p.active) ?? null
  const running = runningBun(p) ?? null
  const serving = await readback(config.socketPath)
  const servingReleaseId = 'unavailable' in serving ? null : (serving.release?.releaseId ?? null)
  return {
    namespace: p.ns,
    role: serviceRole(config),
    socketPath: config.socketPath,
    frontDoor: await frontDoorStatus(p, config),
    supervisor: config.supervisor ?? null,
    launchdPid:
      config.supervisor !== undefined ? (launchdPid(config.supervisor.label) ?? null) : null,
    installedReleases: installed,
    selectedRelease: selected,
    runningProcess: running,
    serving,
    runningEqualsSelected: servingReleaseId !== null && servingReleaseId === selected?.releaseId,
  }
}

/**
 * Put the namespace behind raspd: Bun moves to `<run>/aspd-bun.sock`, raspd
 * from the selected release takes the public socket. Requires a selected
 * release that contains raspd. From sole it is the rollback: Bun aspd comes
 * back on its socket and raspd restarts in front of it.
 */
async function frontDoorEnable(
  nsInput: string,
  labelInput: string | undefined
): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  const role = serviceRole(config)
  if (role === 'sole') return soleToFronted(p, config, labelInput)
  if (role === 'fronted') fail('namespace is already fronted; see front-door-status')
  const active = selectedRelease(p)
  if (inspectRelease(active.releasePath).executableResolution.raspd === undefined) {
    fail(`selected release ${active.releaseId} does not contain raspd; install one that does`)
  }
  const label = labelInput ?? RASPD_DEFAULT_LABEL
  assertLaunchdLabel(label)
  const beganAt = new Date().toISOString()
  const retired = await stopBun(p, config)
  const fronted: ServiceConfig = {
    ...config,
    frontDoor: { bunSocketPath: join(dirname(config.socketPath), BUN_FRONTED_SOCKET), label },
  }
  writeJsonAtomic(p.config, fronted)
  const started = await start(p, fronted)
  return { mode: 'fronted', beganAt, retired, started, status: await frontDoorStatus(p, fronted) }
}

/**
 * Sole to fronted: start Bun aspd from the active release on its socket (its
 * launchd job back when supervised) while sole raspd still serves, then
 * restart raspd with `--upstream`.
 */
async function soleToFronted(
  p: NamespacePaths,
  config: ServiceConfig,
  labelInput: string | undefined
): Promise<Record<string, unknown>> {
  const front = config.frontDoor as NonNullable<ServiceConfig['frontDoor']>
  if (labelInput !== undefined && labelInput !== front.label) {
    fail(`namespace is sole with raspd label ${front.label}; front-door-enable keeps it`)
  }
  const active = selectedRelease(p)
  const beganAt = new Date().toISOString()
  const { sole: _sole, ...frontDoor } = front
  const fronted: ServiceConfig = { ...config, frontDoor }
  // Bun comes up first, so the config never names a fronted role with no Bun
  // behind it; startRaspd then restarts the sole raspd with `--upstream`.
  const bun = await startBun(p, fronted)
  writeJsonAtomic(p.config, fronted)
  const raspd = await startRaspd(p, fronted, active)
  const status = await frontDoorStatus(p, fronted)
  if (status['bunAnswering'] !== true)
    fail(`Bun aspd does not answer on ${frontDoor.bunSocketPath}`)
  return { mode: 'fronted', from: 'sole', beganAt, started: { bun, raspd }, status }
}

/**
 * Fronted to sole (T-13018 section 4): retire Bun aspd (socket, and under
 * supervision its job and plist) and restart raspd without `--upstream`.
 * Refuses, before stopping anything, a release whose raspd predates sole.
 */
async function soleEnable(nsInput: string): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  const role = serviceRole(config)
  if (role === 'sole') fail('namespace is already sole; see front-door-status')
  if (role === 'direct')
    fail('namespace is direct; run front-door-enable first, sole is entered from fronted')
  const front = config.frontDoor as NonNullable<ServiceConfig['frontDoor']>
  const active = selectedRelease(p)
  const inspection = inspectRelease(active.releasePath)
  if (inspection.executableResolution.raspd === undefined) {
    fail(`selected release ${active.releaseId} does not contain raspd`)
  }
  assertSoleRelease(inspection, active.releaseId)
  const beganAt = new Date().toISOString()
  const raspdRetired = await stopRaspd(p, config)
  const bunRetired = await stopBun(p, config)
  rmSync(front.bunSocketPath, { force: true })
  if (config.supervisor !== undefined) rmSync(config.supervisor.plistPath, { force: true })
  const sole: ServiceConfig = { ...config, frontDoor: { ...front, sole: true } }
  writeJsonAtomic(p.config, sole)
  const started = await startRaspd(p, sole, active)
  const status = await frontDoorStatus(p, sole)
  if (runningBun(p) !== undefined) fail('a Bun aspd process still belongs to the namespace')
  if (status['bunSocketExists'] === true) fail(`${front.bunSocketPath} still exists`)
  if (status['bunJobLoaded'] === true) fail('the Bun aspd launchd job is still loaded')
  return {
    mode: 'sole',
    beganAt,
    retired: { raspd: raspdRetired, bun: bunRetired },
    started,
    status,
  }
}

/** Take the namespace out of front-door mode: raspd stops, Bun takes the public socket back. */
async function frontDoorDisable(nsInput: string): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  const role: ServiceRole = serviceRole(config)
  if (role === 'sole') {
    fail('namespace is sole; run front-door-enable first, then front-door-disable')
  }
  if (role === 'direct') fail('namespace is not fronted')
  const beganAt = new Date().toISOString()
  const raspd = await stopRaspd(p, config)
  if (config.supervisor !== undefined) {
    rmSync(raspdJob(p, config).plistPath, { force: true })
  }
  const bun = await stopBun(p, config)
  const { frontDoor: _removed, ...direct } = config
  writeJsonAtomic(p.config, direct)
  const started = await startBun(p, direct)
  const status = await frontDoorStatus(p, direct)
  if (status['publicFrontDoor'] !== null) fail('the public socket still answers as raspd')
  return { mode: 'direct', beganAt, retired: { raspd, bun }, started, status }
}

/** A verb over the namespace as it is configured now. */
async function configured(
  nsInput: string,
  verb: (p: NamespacePaths, config: ServiceConfig) => Promise<Record<string, unknown>>
): Promise<Record<string, unknown>> {
  const p = namespacePaths(nsInput)
  return verb(p, requireConfig(p))
}

export async function main(args: string[]): Promise<void> {
  const [command, ns, arg] = args
  if (ns === undefined) {
    fail(
      'usage: <init|start|stop|restart|activate|supervise|log-dir|status|front-door-enable|front-door-disable|front-door-status|sole-enable> <namespace> [arg]'
    )
  }
  let result: unknown
  switch (command) {
    case 'init':
      result = initNamespace(ns, arg)
      break
    case 'start':
      result = await configured(ns, start)
      break
    case 'stop':
      result = await configured(ns, stop)
      break
    case 'restart':
      result = await configured(ns, restart)
      break
    case 'supervise':
      if (arg === undefined) fail('supervise requires a launchd label')
      result = await supervise(ns, arg)
      break
    case 'log-dir':
      if (arg === undefined) fail('log-dir requires an absolute directory')
      result = setLogDir(ns, arg)
      break
    case 'activate':
      if (arg === undefined) fail('activate requires a release id')
      result = await activate(ns, arg)
      break
    case 'status':
      result = await configured(ns, status)
      break
    case 'front-door-enable':
      result = await frontDoorEnable(ns, arg)
      break
    case 'front-door-disable':
      result = await frontDoorDisable(ns)
      break
    case 'front-door-status':
      result = await configured(ns, frontDoorStatus)
      break
    case 'sole-enable':
      result = await soleEnable(ns)
      break
    default:
      fail(`unknown command: ${command}`)
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
}
