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
 *
 * Front door (T-11835, docs/proposals/aspd-rust-front-door.md): a fronted
 * namespace runs raspd from the selected release on the public socket and Bun
 * aspd on `<run>/aspd-bun.sock`. The role is recorded in the service config,
 * so Bun's listen socket follows it; every verb (start, stop, restart,
 * activate, status) acts on both processes. `front-door-enable` and
 * `front-door-disable` switch the role; rollback is the disable.
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
import { createConnection } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import { AspcServiceUnavailableError, AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { inspectRelease } from './asp-release.ts'

const CONFIG_SCHEMA = 'aspd-service-config/v1'
const ACTIVE_SCHEMA = 'aspd-service-activation/v1'
const DEFAULT_INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']
const RETIRE_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 30_000
const RASPD_DEFAULT_LABEL = 'com.praesidium.raspd'
const BUN_FRONTED_SOCKET = 'aspd-bun.sock'

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
  /**
   * Absolute directory for the daemon's logs (logging.md L1). Absent means
   * `<ns>/logs`; the system namespace records `~/praesidium/var/logs/agent-spaces`.
   */
  logDir?: string
  /** Present once `supervise` has handed the service lifetime to launchd. */
  supervisor?: LaunchdSupervisor | undefined
  /**
   * Present while the namespace is fronted: raspd serves `socketPath` and Bun
   * listens on `bunSocketPath`. Under launchd supervision raspd is its own job.
   */
  frontDoor?: FrontDoor | undefined
}

type FrontDoor = {
  bunSocketPath: string
  /** raspd's launchd label when the namespace is supervised. */
  label: string
}

/** Where Bun aspd listens: the public socket, or the private one when fronted. */
function bunSocketPath(config: ServiceConfig): string {
  return config.frontDoor?.bunSocketPath ?? config.socketPath
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
    raspdRunning: join(ns, 'run', 'raspd.json'),
    logs: join(ns, 'logs'),
    launchScript: join(ns, 'service', 'launchd-run.sh'),
    raspdLaunchScript: join(ns, 'service', 'raspd-launchd-run.sh'),
  }
}

/**
 * Log files for a namespace: aspd's own rotated request log (`--log`) and the
 * supervisor's stdout/stderr, which carries lifecycle, fatal and stderr lines.
 */
export function serviceLogPaths(
  ns: string,
  config: Pick<ServiceConfig, 'logDir'>
): {
  dir: string
  request: string
  supervisor: string
  raspdRequest: string
  raspdSupervisor: string
} {
  const dir = config.logDir ?? join(ns, 'logs')
  return {
    dir,
    request: join(dir, 'aspd.log'),
    supervisor: join(dir, 'aspd.err.log'),
    raspdRequest: join(dir, 'raspd.log'),
    raspdSupervisor: join(dir, 'raspd.err.log'),
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

/** Start Bun aspd and, when fronted, raspd in front of it. */
async function start(nsInput: string): Promise<Record<string, unknown>> {
  const bun = await startBun(nsInput)
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (config.frontDoor === undefined) return bun
  return { bun, raspd: await startRaspd(p, config, selectedRelease(p)) }
}

async function startBun(nsInput: string): Promise<Record<string, unknown>> {
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
  const logFd = openSync(logPath, 'a')
  const child = spawn(aspd.launcher, ['serve', '--socket', bunSocketPath(config)], {
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

  const serving = await awaitServing(bunSocketPath(config), active.releaseId, () => {
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
  /** aspd's own request log (`aspd serve --log`). */
  requestLogPath: string
  /** The release executable to run; `raspd` for the front door (default `aspd`). */
  program?: 'aspd' | 'raspd' | undefined
  /** Arguments after `--socket <path>`, before `--log` (raspd's `--upstream`). */
  extraArgs?: string[] | undefined
}): string {
  const program = input.program ?? 'aspd'
  const record = join(input.ns, 'run', `${program}.json`)
  // printf fills the pid and start time; every literal sits inside one quoted format.
  const format = `${JSON.stringify({
    pid: 0,
    releaseId: input.releaseId,
    releasePath: input.releasePath,
    startedAt: '',
    logPath: input.logPath,
    requestLogPath: input.requestLogPath,
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
    // Append mode (O_APPEND) for the supervisor's file, however launchd opened
    // it, so the collective copytruncate rotation (logging standard L4) never
    // leaves an offset gap. aspd does not rotate either of its logs.
    `exec >>${shellQuote(input.logPath)} 2>&1`,
    'started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    `printf ${shellQuote(format)} "$$" "$started_at" >${shellQuote(`${record}.tmp`)}`,
    `mv ${shellQuote(`${record}.tmp`)} ${shellQuote(record)}`,
    `exec /usr/bin/env -i ${env} ${shellQuote(join(input.releasePath, program))} serve --socket ${shellQuote(input.socketPath)}${(input.extraArgs ?? []).map((arg) => ` ${shellQuote(arg)}`).join('')} --log ${shellQuote(input.requestLogPath)}`,
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
  const result = spawnSync('launchctl', args, { encoding: 'utf8', env: process.env })
  return { status: result.status ?? 1, output: `${result.stdout}${result.stderr}` }
}

const BOOTSTRAP_ATTEMPTS = 4
const BOOTSTRAP_RETRY_MS = 2_000

/**
 * launchd-jobs standard: adopt the written plist with the host-local adopter
 * when one is installed (no adopter on mini). An adopter failure fails the
 * operation; ProgramArguments[0] becomes the praesidium-launch shim.
 */
export function adoptLaunchdPlist(plistPath: string): void {
  const adopt = spawnSync(
    '/bin/sh',
    ['-c', 'if command -v praesidium-adopt >/dev/null; then praesidium-adopt "$dst"; fi'],
    { encoding: 'utf8', env: { ...process.env, dst: plistPath } }
  )
  if (adopt.status !== 0) {
    fail(`praesidium-adopt failed for ${plistPath}: ${`${adopt.stdout}${adopt.stderr}`.trim()}`)
  }
}

/** Bootstrap, retrying launchd's transient error 5 that can follow a bootout. */
export async function bootstrapLaunchd(
  domain: string,
  plistPath: string,
  retryMs = BOOTSTRAP_RETRY_MS
): Promise<{ attempts: number }> {
  for (let attempt = 1; ; attempt++) {
    const booted = launchctl(['bootstrap', domain, plistPath])
    if (booted.status === 0) return { attempts: attempt }
    const transient = booted.status === 5 || /\b5: Input\/output error/.test(booted.output)
    if (!transient || attempt >= BOOTSTRAP_ATTEMPTS) {
      fail(`launchctl bootstrap failed after ${attempt} attempt(s): ${booted.output.trim()}`)
    }
    await Bun.sleep(retryMs)
  }
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
): void {
  const logs = serviceLogPaths(p.ns, config)
  mkdirSync(logs.dir, { recursive: true, mode: 0o700 })
  const script = renderLaunchdScript({
    ns: p.ns,
    socketPath: bunSocketPath(config),
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    env: serviceEnv(config),
    logPath: logs.supervisor,
    requestLogPath: logs.request,
  })
  const tmp = `${p.launchScript}.tmp-${process.pid}`
  writeFileSync(tmp, script, { mode: 0o700 })
  renameSync(tmp, p.launchScript)
}

/**
 * Regenerate and adopt the plist from the config. launchd reads it only on
 * bootstrap, so callers write it while the job is unloaded or accept that it
 * takes effect at the next load.
 */
function writeLaunchdPlist(p: ReturnType<typeof paths>, config: ServiceConfig): void {
  const supervisor = config.supervisor as LaunchdSupervisor
  const plistPath = supervisor.plistPath
  mkdirSync(dirname(plistPath), { recursive: true })
  const plistTmp = `${plistPath}.tmp-${process.pid}`
  writeFileSync(
    plistTmp,
    renderLaunchdPlist({
      label: supervisor.label,
      launchScript: p.launchScript,
      logPath: serviceLogPaths(p.ns, config).supervisor,
    })
  )
  renameSync(plistTmp, plistPath)
  adoptLaunchdPlist(plistPath)
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
    // Every load rewrites and re-adopts the plist, so a load always carries the
    // configured log paths and adoption, even for a plist written before either.
    writeLaunchdPlist(p, config)
    await bootstrapLaunchd(
      launchdTarget(supervisor.label).replace(/\/[^/]+$/, ''),
      supervisor.plistPath
    )
  } else if (launchdPid(supervisor.label) === undefined) {
    const kicked = launchctl(['kickstart', launchdTarget(supervisor.label)])
    if (kicked.status !== 0) fail(`launchctl kickstart failed: ${kicked.output.trim()}`)
  }
  const serving = await awaitServing(bunSocketPath(config), active.releaseId)
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
  const serving = await awaitServing(bunSocketPath(config), active.releaseId)
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
    socketAfterStop: await readback(bunSocketPath(config)),
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
  writeLaunchScript(p, supervised, active)
  writeLaunchdPlist(p, supervised)
  writeJsonAtomic(p.config, supervised)
  const started = await startSupervised(p, supervised, active)
  return { supervised: supervisor, retired, started }
}

/**
 * Record where the daemon logs. Only the config changes: the running daemon
 * keeps its open files, and the next activation (which reloads a supervised
 * job's plist and script) or unsupervised start writes to the new directory.
 */
function setLogDir(nsInput: string, logDir: string): Record<string, unknown> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (!isAbsolute(logDir)) fail(`log dir must be absolute: ${logDir}`)
  const previous = serviceLogPaths(p.ns, config).dir
  const next: ServiceConfig = { ...config, logDir: resolve(logDir) }
  if (previous !== next.logDir) writeJsonAtomic(p.config, next)
  return { namespace: p.ns, previous, logDir: next.logDir, changed: previous !== next.logDir }
}

/** Stop raspd (when fronted) and then Bun aspd. */
async function stop(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (config.frontDoor === undefined) return stopBun(nsInput)
  const raspd = await stopRaspd(p, config)
  return { raspd, bun: await stopBun(nsInput) }
}

async function stopBun(nsInput: string): Promise<Record<string, unknown>> {
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
    socketAfterStop: await readback(bunSocketPath(config)),
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
  if (
    requireConfig(p).frontDoor !== undefined &&
    inspection.executableResolution.raspd === undefined
  ) {
    fail(`namespace is fronted and release ${releaseId} does not contain raspd`)
  }
  const previous = readJson<ActiveSelection>(p.active)
  const beganAt = new Date().toISOString()
  const config = requireConfig(p)
  // A fronted namespace retires raspd first and starts it last, on the newly
  // selected release, so it never fronts a Bun from another release.
  const raspdRetired = config.frontDoor !== undefined ? await stopRaspd(p, config) : undefined
  const raspdOf = async (selection: ActiveSelection) =>
    config.frontDoor !== undefined
      ? { raspdRetired, raspdStarted: await startRaspd(p, config, selection) }
      : {}
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
      ...(await raspdOf(selection)),
      completedAt: new Date().toISOString(),
    }
    appendFileSync(p.activations, `${JSON.stringify(result)}\n`)
    return result
  }
  const retired = await stopBun(nsInput)
  const selection: ActiveSelection = {
    schemaVersion: ACTIVE_SCHEMA,
    releaseId,
    releasePath,
    activatedAt: new Date().toISOString(),
    previousReleaseId: previous?.releaseId ?? null,
  }
  writeJsonAtomic(p.active, selection)
  const started = await startBun(nsInput)
  const result = {
    activation: selection,
    beganAt,
    retired,
    started,
    ...(await raspdOf(selection)),
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

// -- front door (T-11835) ------------------------------------------------------

/** One version call on `socketPath`; undefined when nothing answers. */
async function versionOf(socketPath: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolveVersion) => {
    const socket = createConnection({ path: socketPath })
    let buffer = ''
    const done = (value: Record<string, unknown> | undefined) => {
      socket.destroy()
      resolveVersion(value)
    }
    socket.setTimeout(2_000, () => done(undefined))
    socket.once('error', () => done(undefined))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, unknown> }
        done(reply.result)
      } catch {
        done(undefined)
      }
    })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'version', params: {} })}\n`)
  })
}

/** The raspd process recorded for this namespace, if it is still raspd from that release. */
function runningRaspd(p: ReturnType<typeof paths>): RunningRecord | undefined {
  const record = readJson<RunningRecord>(p.raspdRunning)
  if (record === undefined || !pidAlive(record.pid)) return undefined
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(record.pid)], {
    encoding: 'utf8',
  }).stdout
  return command.includes(join(record.releasePath, 'libexec', 'raspd')) ||
    command.includes(join(record.releasePath, 'raspd'))
    ? record
    : undefined
}

/** Wait until the public socket answers as raspd fronting `releaseId`. */
async function awaitFrontDoor(
  socketPath: string,
  releaseId: string,
  check: () => void = () => undefined
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const version = await versionOf(socketPath)
    const front = version?.['frontDoor'] as { name?: unknown } | undefined
    const release = version?.['release'] as { releaseId?: unknown } | undefined
    if (front?.name === 'raspd') {
      if (release?.releaseId !== releaseId) {
        fail(`raspd answered as ${String(release?.releaseId)}, expected ${releaseId}`)
      }
      return version as Record<string, unknown>
    }
    check()
    if (Date.now() > deadline)
      fail(`raspd did not answer on ${socketPath} within ${READY_TIMEOUT_MS}ms`)
    await Bun.sleep(100)
  }
}

function raspdLaunchd(p: ReturnType<typeof paths>, config: ServiceConfig): LaunchdSupervisor {
  const label = (config.frontDoor as FrontDoor).label
  const home = process.env.HOME ?? fail('HOME is required to place the launchd plist')
  return {
    kind: 'launchd',
    label,
    plistPath: join(home, 'Library', 'LaunchAgents', `${label}.plist`),
    launchScript: p.raspdLaunchScript,
  }
}

/** Start raspd from `active` on the public socket, in front of Bun's socket. */
async function startRaspd(
  p: ReturnType<typeof paths>,
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
    const supervisor = raspdLaunchd(p, config)
    const script = renderLaunchdScript({
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
    const tmp = `${supervisor.launchScript}.tmp-${process.pid}`
    writeFileSync(tmp, script, { mode: 0o700 })
    renameSync(tmp, supervisor.launchScript)
    if (launchdLoaded(supervisor.label)) {
      const booted = launchctl(['bootout', launchdTarget(supervisor.label)])
      if (booted.status !== 0) fail(`launchctl bootout failed: ${booted.output.trim()}`)
    }
    mkdirSync(dirname(supervisor.plistPath), { recursive: true })
    const plistTmp = `${supervisor.plistPath}.tmp-${process.pid}`
    writeFileSync(
      plistTmp,
      renderLaunchdPlist({
        label: supervisor.label,
        launchScript: supervisor.launchScript,
        logPath: logs.raspdSupervisor,
      })
    )
    renameSync(plistTmp, supervisor.plistPath)
    adoptLaunchdPlist(supervisor.plistPath)
    await bootstrapLaunchd(
      launchdTarget(supervisor.label).replace(/\/[^/]+$/, ''),
      supervisor.plistPath
    )
    const serving = await awaitFrontDoor(config.socketPath, active.releaseId)
    return { supervisor, launchdPid: launchdPid(supervisor.label) ?? null, serving }
  }

  const startedAt = new Date().toISOString()
  const logFd = openSync(logs.raspdSupervisor, 'a')
  const child = spawn(
    raspd.launcher,
    ['serve', '--socket', config.socketPath, ...args, '--log', logs.raspdRequest],
    { cwd: p.ns, env: serviceEnv(config), detached: true, stdio: ['ignore', logFd, logFd] }
  )
  closeSync(logFd)
  if (child.pid === undefined) fail('failed to spawn raspd')
  child.unref()
  const record: RunningRecord = {
    pid: child.pid,
    releaseId: active.releaseId,
    releasePath: active.releasePath,
    startedAt,
    logPath: logs.raspdSupervisor,
  }
  writeJsonAtomic(p.raspdRunning, record)
  const serving = await awaitFrontDoor(config.socketPath, active.releaseId, () => {
    if (!pidAlive(child.pid as number))
      fail(`raspd did not become ready; see ${logs.raspdSupervisor}`)
  })
  return { started: record, serving, readyAt: new Date().toISOString() }
}

/** Retire raspd (SIGTERM drains it) and wait for it to exit. */
async function stopRaspd(
  p: ReturnType<typeof paths>,
  config: ServiceConfig
): Promise<Record<string, unknown>> {
  const signalledAt = new Date().toISOString()
  if (config.supervisor !== undefined && config.frontDoor !== undefined) {
    const supervisor = raspdLaunchd(p, config)
    const pid = launchdPid(supervisor.label)
    if (launchdLoaded(supervisor.label)) {
      const booted = launchctl(['bootout', launchdTarget(supervisor.label)])
      if (booted.status !== 0) fail(`launchctl bootout failed: ${booted.output.trim()}`)
    }
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

async function frontDoorStatus(
  p: ReturnType<typeof paths>,
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

/**
 * Put the namespace behind raspd: Bun moves to `<run>/aspd-bun.sock`, raspd
 * from the selected release takes the public socket. Requires a selected
 * release that contains raspd.
 */
async function frontDoorEnable(
  nsInput: string,
  labelInput: string | undefined
): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (config.frontDoor !== undefined) fail('namespace is already fronted; see front-door-status')
  const active = selectedRelease(p)
  if (inspectRelease(active.releasePath).executableResolution.raspd === undefined) {
    fail(`selected release ${active.releaseId} does not contain raspd; install one that does`)
  }
  const label = labelInput ?? RASPD_DEFAULT_LABEL
  if (!/^[A-Za-z0-9.-]+$/.test(label)) fail(`invalid launchd label: ${label}`)
  const beganAt = new Date().toISOString()
  const retired = await stopBun(nsInput)
  const fronted: ServiceConfig = {
    ...config,
    frontDoor: { bunSocketPath: join(dirname(config.socketPath), BUN_FRONTED_SOCKET), label },
  }
  writeJsonAtomic(p.config, fronted)
  const started = await start(nsInput)
  return { mode: 'fronted', beganAt, retired, started, status: await frontDoorStatus(p, fronted) }
}

/** Take the namespace out of front-door mode: raspd stops, Bun takes the public socket back. */
async function frontDoorDisable(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
  if (config.frontDoor === undefined) fail('namespace is not fronted')
  const beganAt = new Date().toISOString()
  const raspd = await stopRaspd(p, config)
  if (config.supervisor !== undefined) {
    rmSync(raspdLaunchd(p, config).plistPath, { force: true })
  }
  const bun = await stopBun(nsInput)
  const { frontDoor: _removed, ...direct } = config
  writeJsonAtomic(p.config, direct)
  const started = await startBun(nsInput)
  const status = await frontDoorStatus(p, direct)
  if (status['publicFrontDoor'] !== null) fail('the public socket still answers as raspd')
  return { mode: 'direct', beganAt, retired: { raspd, bun }, started, status }
}

export async function main(args: string[]): Promise<void> {
  const [command, ns, arg] = args
  if (ns === undefined) {
    fail(
      'usage: <init|start|stop|restart|activate|supervise|log-dir|status|front-door-enable|front-door-disable|front-door-status> <namespace> [arg]'
    )
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
        config.frontDoor !== undefined
          ? { stop: await stop(ns), start: await start(ns) }
          : config.supervisor !== undefined
            ? await restartSupervised(p, config, selectedRelease(p))
            : { stop: await stop(ns), start: await start(ns) }
      break
    }
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
      result = await status(ns)
      break
    case 'front-door-enable':
      result = await frontDoorEnable(ns, arg)
      break
    case 'front-door-disable':
      result = await frontDoorDisable(ns)
      break
    case 'front-door-status': {
      const p = paths(ns)
      result = await frontDoorStatus(p, requireConfig(p))
      break
    }
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
