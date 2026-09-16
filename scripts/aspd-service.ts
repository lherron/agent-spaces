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
import { isAbsolute, join, resolve } from 'node:path'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import { AspcServiceUnavailableError, AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { inspectRelease } from './asp-release.ts'

const CONFIG_SCHEMA = 'aspd-service-config/v1'
const ACTIVE_SCHEMA = 'aspd-service-activation/v1'
const DEFAULT_INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']
const RETIRE_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 30_000

type ServiceConfig = {
  schemaVersion: typeof CONFIG_SCHEMA
  socketPath: string
  /** Explicit external inputs for preparation (ASP_HOME, ASP_CODEX_PATH, …). */
  env: Record<string, string>
  inheritEnv: string[]
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

  const env: Record<string, string> = {}
  for (const key of config.inheritEnv) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, config.env)
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

  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const hello = await readback(config.socketPath)
    if (!('unavailable' in hello)) {
      if (hello.release?.releaseId !== active.releaseId) {
        fail(
          `socket answered as ${hello.release?.releaseId ?? '(unidentified)'}, expected ${active.releaseId}`
        )
      }
      return { started: record, serving: hello, readyAt: new Date().toISOString() }
    }
    if (!pidAlive(child.pid) || Date.now() > deadline) {
      fail(`aspd did not become ready; see ${logPath}`)
    }
    await Bun.sleep(100)
  }
}

async function stop(nsInput: string): Promise<Record<string, unknown>> {
  const p = paths(nsInput)
  const config = requireConfig(p)
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
    installedReleases: installed,
    selectedRelease: selected,
    runningProcess: running,
    serving,
    runningEqualsSelected: servingReleaseId !== null && servingReleaseId === selected?.releaseId,
  }
}

export async function main(args: string[]): Promise<void> {
  const [command, ns, arg] = args
  if (ns === undefined) fail('usage: <init|start|stop|restart|activate|status> <namespace> [arg]')
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
    case 'restart':
      result = { stop: await stop(ns), start: await start(ns) }
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
