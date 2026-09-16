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
 * the service lifetime to a per-user launchd job instead; the same verbs then
 * act through launchd, which owns the one `aspd` process (no second
 * supervisor). The job runs a generated launch script that `exec`s the selected
 * release with a literal environment, so the job pid IS the daemon and
 * launchd's SIGTERM is the existing graceful retire.
 */
import { spawn, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import { AspcServiceUnavailableError, AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { inspectRelease } from './asp-release.ts'

const CONFIG_SCHEMA = 'aspd-service-config/v1'
const ACTIVE_SCHEMA = 'aspd-service-activation/v1'
const DEFAULT_INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']
const RETIRE_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 30_000

type LaunchdSupervisor = {
  kind: 'launchd'
  label: string
  plistPath: string
  launchScript: string
}

type ServiceConfig = {
  schemaVersion: typeof CONFIG_SCHEMA
  socketPath: string
  /** Explicit external inputs for preparation (ASP_HOME, ASP_CODEX_PATH, …). */
  env: Record<string, string>
  inheritEnv: string[]
  /** Present once `supervise` has handed the service lifetime to launchd. */
  supervisor?: LaunchdSupervisor | undefined
}

type ActiveSelection = {
  schemaVersion: typeof ACTIVE_SCHEMA
  releaseId: string
  releasePath: string
  activatedAt: string
  previousReleaseId: string | null
}

type RunningRecord = {
  pid: number
  releaseId: string
  releasePath: string
  startedAt: string
  logPath: string
}

function fail(message: string): never {
  throw new Error(`aspd-service: ${message}`)
}

function paths(nsInput: string) {
  if (!isAbsolute(nsInput)) fail(`namespace must be absolute: ${nsInput}`)
  const ns = resolve(nsInput)
  return {
    ns,
    releases: join(ns, 'releases'),
    config: join(ns, 'service', 'config.json'),
    active: join(ns, 'service', 'active.json'),
    activations: join(ns, 'service', 'activations.ndjson'),
    running: join(ns, 'run', 'aspd.json'),
    logs: join(ns, 'logs'),
    launchScript: join(ns, 'service', 'launchd-run.sh'),
  }
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

function requireConfig(p: ReturnType<typeof paths>): ServiceConfig {
  const config = readJson<ServiceConfig>(p.config)
  if (config?.schemaVersion !== CONFIG_SCHEMA) fail(`namespace not initialized: ${p.config}`)
  return config
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A pid counts as our daemon only if it is still executing the recorded release. */
function runningDaemon(p: ReturnType<typeof paths>): RunningRecord | undefined {
  const record = readJson<RunningRecord>(p.running)
  if (record === undefined || !pidAlive(record.pid)) return undefined
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(record.pid)], {
    encoding: 'utf8',
  }).stdout
  return command.includes(join(record.releasePath, 'libexec', 'aspd')) ||
    command.includes(join(record.releasePath, 'aspd'))
    ? record
    : undefined
}

async function readback(socketPath: string): Promise<AspcHelloResponse | { unavailable: string }> {
  try {
    const client = await AspcUnixClient.connect({
      socketPath,
      clientInfo: { name: 'aspd-service' },
      timeoutMs: 2_000,
    })
    const hello = client.hello
    await client.close()
    return hello
  } catch (error) {
    if (error instanceof AspcServiceUnavailableError) return { unavailable: error.message }
    throw error
  }
}

function init(nsInput: string, codexPath: string | undefined): unknown {
  const p = paths(nsInput)
  for (const dir of [p.releases, join(p.ns, 'service'), join(p.ns, 'run'), p.logs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
  }
  const aspHome = join(p.ns, 'state', 'asp-home')
  mkdirSync(aspHome, { recursive: true, mode: 0o700 })
  const config: ServiceConfig = {
    schemaVersion: CONFIG_SCHEMA,
    socketPath: join(p.ns, 'run', 'aspd.sock'),
    env: {
      ASP_HOME: aspHome,
      ...(codexPath !== undefined && codexPath.length > 0
        ? { ASP_CODEX_PATH: codexPath, ASP_CODEX_SKIP_COMMON_PATHS: '1' }
        : {}),
    },
    inheritEnv: DEFAULT_INHERITED_ENV,
  }
  writeJsonAtomic(p.config, config)
  return { initialized: p.ns, config }
}

function selectedRelease(p: ReturnType<typeof paths>): ActiveSelection {
  const active = readJson<ActiveSelection>(p.active)
  if (active?.schemaVersion !== ACTIVE_SCHEMA) fail('no release has been activated')
  return active
}

async function start(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  const active = selectedRelease(p)
  const existing = runningDaemon(p)
  if (existing !== undefined) {
    if (existing.releaseId !== active.releaseId) {
      fail(
        `running ${existing.releaseId} differs from selected ${active.releaseId}; activate instead`
      )
    }
    return { alreadyRunning: existing, serving: await readback(config.socketPath) }
  }
  const inspection = inspectRelease(active.releasePath)
  const aspd = inspection.executableResolution.aspd
  if (aspd === undefined || !aspd.embeddedIdentity) {
    fail(`release ${active.releaseId} does not contain an identity-bound aspd`)
  }

  if (config.supervisor !== undefined) return startSupervised(p, config, active)
  const env = serviceEnv(config)
  const startedAt = new Date().toISOString()
  const logPath = join(p.logs, `aspd-${active.releaseId}-${startedAt.replace(/[:.]/g, '')}.log`)
  const logFd = openSync(logPath, 'a')
  const child = spawn(aspd.launcher, ['serve', '--socket', config.socketPath], {
    cwd: p.ns,
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  if (child.pid === undefined) fail('failed to spawn aspd')
  child.unref()
  const record: RunningRecord = {
    pid: child.pid,
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    startedAt,
    logPath,
  }
  writeJsonAtomic(p.running, record)

  const serving = await awaitServing(config.socketPath, active.releaseId, () => {
    if (!pidAlive(child.pid as number)) fail(`aspd did not become ready; see ${logPath}`)
  })
  return { started: record, serving, readyAt: new Date().toISOString() }
}

function serviceEnv(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of config.inheritEnv) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, config.env)
  return env
}

/** Wait for the socket to answer as `releaseId`; a different identity is a failure. */
async function awaitServing(
  socketPath: string,
  releaseId: string,
  check: () => void = () => undefined
): Promise<AspcHelloResponse> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const hello = await readback(socketPath)
    if (!('unavailable' in hello)) {
      if (hello.release?.releaseId !== releaseId) {
        fail(
          `socket answered as ${hello.release?.releaseId ?? '(unidentified)'}, expected ${releaseId}`
        )
      }
      return hello
    }
    check()
    if (Date.now() > deadline)
      fail(`aspd did not answer as ${releaseId} within ${READY_TIMEOUT_MS}ms`)
    await Bun.sleep(100)
  }
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const xmlEscape = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

/**
 * The launchd job's program. Everything is literal: the selected release, the
 * socket and the complete environment (`env -i`), so nothing ambient from
 * launchd reaches the daemon. `exec` keeps the job pid as the daemon pid.
 */
export function renderLaunchdScript(input: {
  ns: string
  socketPath: string
  releaseId: string
  releasePath: string
  env: Record<string, string>
  logPath: string
}): string {
  // printf fills the pid and start time; every literal sits inside one quoted format.
  const format = `${JSON.stringify({
    pid: 0,
    releaseId: input.releaseId,
    releasePath: input.releasePath,
    startedAt: '',
    logPath: input.logPath,
  })
    .replaceAll('%', '%%')
    .replace('"pid":0', '"pid":%s')
    .replace('"startedAt":""', '"startedAt":"%s"')}\\n`
  const env = Object.keys(input.env)
    .sort()
    .map((key) => shellQuote(`${key}=${input.env[key]}`))
    .join(' ')
  return [
    '#!/bin/sh',
    '# Generated by agent-spaces scripts/aspd-service.ts on activation; do not edit.',
    'set -eu',
    `cd ${shellQuote(input.ns)}`,
    'started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `printf ${shellQuote(format)} "$$" "$started_at" >${shellQuote(join(input.ns, 'run', 'aspd.json.tmp'))}`,
    `mv ${shellQuote(join(input.ns, 'run', 'aspd.json.tmp'))} ${shellQuote(join(input.ns, 'run', 'aspd.json'))}`,
    `exec /usr/bin/env -i ${env} ${shellQuote(join(input.releasePath, 'aspd'))} serve --socket ${shellQuote(input.socketPath)}`,
    '',
  ].join('\n')
}

export function renderLaunchdPlist(input: {
  label: string
  launchScript: string
  logPath: string
}): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(input.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${xmlEscape(input.launchScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>${Math.ceil(RETIRE_TIMEOUT_MS / 1000)}</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(input.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(input.logPath)}</string>
</dict>
</plist>
`
}

function launchctl(args: string[]): { status: number; output: string } {
  const result = spawnSync('launchctl', args, { encoding: 'utf8' })
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}

function launchdTarget(label: string): string {
  return `gui/${process.getuid?.() ?? fail('launchd supervision needs a uid')}/${label}`
}

function launchdPid(label: string): number | undefined {
  const printed = launchctl(['print', launchdTarget(label)])
  if (printed.status !== 0) return undefined
  const match = /^\s*pid = (\d+)$/m.exec(printed.output)
  return match ? Number(match[1]) : undefined
}

function launchdLoaded(label: string): boolean {
  return launchctl(['print', launchdTarget(label)]).status === 0
}

/** Regenerate the launch script for the current selection (atomic write). */
function writeLaunchScript(
  p: ReturnType<typeof paths>,
  config: ServiceConfig,
  active: ActiveSelection
): string {
  const logPath = join(p.logs, 'aspd-launchd.log')
  const script = renderLaunchdScript({
    ns: p.ns,
    socketPath: config.socketPath,
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    env: serviceEnv(config),
    logPath,
  })
  const tmp = `${p.launchScript}.tmp-${process.pid}`
  writeFileSync(tmp, script, { mode: 0o700 })
  renameSync(tmp, p.launchScript)
  return logPath
}

async function awaitPidExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  const deadline = Date.now() + RETIRE_TIMEOUT_MS + 5_000
  while (pidAlive(pid)) {
    if (Date.now() > deadline) fail(`previous aspd pid ${pid} did not exit`)
    await Bun.sleep(50)
  }
}

/** Start (or confirm) the supervised daemon on the current selection. */
async function startSupervised(
  p: ReturnType<typeof paths>,
  config: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  writeLaunchScript(p, config, active)
  if (!launchdLoaded(supervisor.label)) {
    const booted = launchctl([
      'bootstrap',
      launchdTarget(supervisor.label).replace(/\/[^/]+$/, ''),
      supervisor.plistPath,
    ])
    if (booted.status !== 0) fail(`launchctl bootstrap failed: ${booted.output.trim()}`)
  } else if (launchdPid(supervisor.label) === undefined) {
    const kicked = launchctl(['kickstart', launchdTarget(supervisor.label)])
    if (kicked.status !== 0) fail(`launchctl kickstart failed: ${kicked.output.trim()}`)
  }
  const serving = await awaitServing(config.socketPath, active.releaseId)
  return {
    supervisor,
    launchdPid: launchdPid(supervisor.label) ?? null,
    running: runningDaemon(p) ?? null,
    serving,
    readyAt: new Date().toISOString(),
  }
}

/** Retire the supervised daemon and start the current selection through launchd. */
async function restartSupervised(
  p: ReturnType<typeof paths>,
  config: ServiceConfig,
  active: ActiveSelection
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  if (!launchdLoaded(supervisor.label)) return startSupervised(p, config, active)
  writeLaunchScript(p, config, active)
  const previousPid = launchdPid(supervisor.label)
  const signalledAt = new Date().toISOString()
  const kicked = launchctl(['kickstart', '-k', launchdTarget(supervisor.label)])
  if (kicked.status !== 0) fail(`launchctl kickstart -k failed: ${kicked.output.trim()}`)
  await awaitPidExit(previousPid)
  const retiredAt = new Date().toISOString()
  const serving = await awaitServing(config.socketPath, active.releaseId)
  const pid = launchdPid(supervisor.label)
  if (pid === undefined || pid === previousPid) fail('launchd did not start a new aspd process')
  return {
    supervisor,
    previousPid: previousPid ?? null,
    signalledAt,
    retiredAt,
    launchdPid: pid,
    running: runningDaemon(p) ?? null,
    serving,
    readyAt: new Date().toISOString(),
  }
}

async function stopSupervised(
  p: ReturnType<typeof paths>,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const supervisor = config.supervisor as LaunchdSupervisor
  const pid = launchdPid(supervisor.label)
  const signalledAt = new Date().toISOString()
  if (launchdLoaded(supervisor.label)) {
    const booted = launchctl(['bootout', launchdTarget(supervisor.label)])
    if (booted.status !== 0) fail(`launchctl bootout failed: ${booted.output.trim()}`)
  }
  await awaitPidExit(pid)
  rmSync(p.running, { force: true })
  return {
    stopped: pid !== undefined,
    supervisor,
    pid: pid ?? null,
    signalledAt,
    exitedAt: new Date().toISOString(),
    socketAfterStop: await readback(config.socketPath),
  }
}

/**
 * Hand the service lifetime to a per-user launchd job. Requires a selection.
 * An unsupervised daemon is retired first so there is never a second owner.
 */
async function supervise(nsInput: string, label: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  const active = selectedRelease(p)
  if (!/^[A-Za-z0-9.-]+$/.test(label)) fail(`invalid launchd label: ${label}`)
  const home = process.env.HOME ?? fail('HOME is required to place the launchd plist')
  const plistPath = join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  const previous = config.supervisor
  if (previous !== undefined && previous.label !== label) {
    fail(`namespace is already supervised by ${previous.label}`)
  }
  const retired =
    previous === undefined ? await stop(nsInput) : { stopped: false, reason: 'already supervised' }
  const supervisor: LaunchdSupervisor = {
    kind: 'launchd',
    label,
    plistPath,
    launchScript: p.launchScript,
  }
  const supervised: ServiceConfig = { ...config, supervisor }
  const logPath = writeLaunchScript(p, supervised, active)
  mkdirSync(dirname(plistPath), { recursive: true })
  const plistTmp = `${plistPath}.tmp-${process.pid}`
  writeFileSync(plistTmp, renderLaunchdPlist({ label, launchScript: p.launchScript, logPath }))
  renameSync(plistTmp, plistPath)
  writeJsonAtomic(p.config, supervised)
  const started = await startSupervised(p, supervised, active)
  return { supervised: supervisor, retired, started }
}

async function stop(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (config.supervisor !== undefined) return stopSupervised(p, config)
  const record = runningDaemon(p)
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
    socketAfterStop: await readback(config.socketPath),
  }
}

async function activate(nsInput: string, releaseId: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  requireConfig(p)
  const releasePath = realpathSync(join(p.releases, releaseId))
  const inspection = inspectRelease(releasePath)
  if (inspection.executableResolution.aspd?.embeddedIdentity !== true) {
    fail(`release ${releaseId} does not contain an identity-bound aspd`)
  }
  const previous = readJson<ActiveSelection>(p.active)
  const beganAt = new Date().toISOString()
  const config = requireConfig(p)
  if (config.supervisor !== undefined) {
    // Same order as the unsupervised path: retire, select, start. `bootout`
    // unloads the job, so KeepAlive cannot respawn anything while the selection
    // changes; `bootstrap` then starts only the newly selected release.
    const retired = await stopSupervised(p, config)
    const selection: ActiveSelection = {
      schemaVersion: ACTIVE_SCHEMA,
      releaseId,
      releasePath,
      activatedAt: new Date().toISOString(),
      previousReleaseId: previous?.releaseId ?? null,
    }
    writeJsonAtomic(p.active, selection)
    const started = await startSupervised(p, config, selection)
    const result = {
      activation: selection,
      beganAt,
      retired,
      started,
      completedAt: new Date().toISOString(),
    }
    appendFileSync(p.activations, `${JSON.stringify(result)}\n`)
    return result
  }
  const retired = await stop(nsInput)
  const selection: ActiveSelection = {
    schemaVersion: ACTIVE_SCHEMA,
    releaseId,
    releasePath,
    activatedAt: new Date().toISOString(),
    previousReleaseId: previous?.releaseId ?? null,
  }
  writeJsonAtomic(p.active, selection)
  const started = await start(nsInput)
  const result = {
    activation: selection,
    beganAt,
    retired,
    started,
    completedAt: new Date().toISOString(),
  }
  appendFileSync(p.activations, `${JSON.stringify(result)}\n`)
  return result
}

async function status(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  const installed = existsSync(p.releases)
    ? readdirSync(p.releases)
        .filter((entry) => entry.startsWith('asp-'))
        .sort()
    : []
  const selected = readJson<ActiveSelection>(p.active) ?? null
  const running = runningDaemon(p) ?? null
  const serving = await readback(config.socketPath)
  const servingReleaseId = 'unavailable' in serving ? null : (serving.release?.releaseId ?? null)
  return {
    namespace: p.ns,
    socketPath: config.socketPath,
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

export async function main(args: string[]): Promise<void> {
  const [command, ns, arg] = args
  if (ns === undefined) {
    fail('usage: <init|start|stop|restart|activate|supervise|status> <namespace> [arg]')
  }
  let result: unknown
  switch (command) {
    case 'init':
      result = init(ns, arg)
      break
    case 'start':
      result = await start(ns)
      break
    case 'stop':
      result = await stop(ns)
      break
    case 'restart': {
      const p = paths(ns)
      const config = requireConfig(p)
      result =
        config.supervisor !== undefined
          ? await restartSupervised(p, config, selectedRelease(p))
          : { stop: await stop(ns), start: await start(ns) }
      break
    }
    case 'supervise':
      if (arg === undefined) fail('supervise requires a launchd label')
      result = await supervise(ns, arg)
      break
    case 'activate':
      if (arg === undefined) fail('activate requires a release id')
      result = await activate(ns, arg)
      break
    case 'status':
      result = await status(ns)
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
