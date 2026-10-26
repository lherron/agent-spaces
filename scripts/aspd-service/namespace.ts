/**
 * The aspd namespace on disk: its layout, the service config, the selected
 * release and the running-process records, plus the two verbs that only edit
 * the config (`init`, `log-dir`). Every other module reads the namespace
 * through here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const CONFIG_SCHEMA = 'aspd-service-config/v1'
export const ACTIVE_SCHEMA = 'aspd-service-activation/v1'
const DEFAULT_INHERITED_ENV = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG']

export type LaunchdSupervisor = {
  kind: 'launchd'
  label: string
  plistPath: string
  launchScript: string
}

export type ServiceConfig = {
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

export type FrontDoor = {
  bunSocketPath: string
  /** raspd's launchd label when the namespace is supervised. */
  label: string
}

export type ActiveSelection = {
  schemaVersion: typeof ACTIVE_SCHEMA
  releaseId: string
  releasePath: string
  activatedAt: string
  previousReleaseId: string | null
}

export type RunningRecord = {
  pid: number
  releaseId: string
  releasePath: string
  startedAt: string
  logPath: string
}

export function fail(message: string): never {
  throw new Error(`aspd-service: ${message}`)
}

export type NamespacePaths = ReturnType<typeof namespacePaths>

export function namespacePaths(nsInput: string) {
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

/** Where Bun aspd listens: the public socket, or the private one when fronted. */
export function bunSocketPath(config: ServiceConfig): string {
  return config.frontDoor?.bunSocketPath ?? config.socketPath
}

/** The daemons' complete environment: the inherited keys, then the config's literals. */
export function serviceEnv(config: ServiceConfig): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of config.inheritEnv) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  Object.assign(env, config.env)
  return env
}

export function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
}

export function requireConfig(p: NamespacePaths): ServiceConfig {
  const config = readJson<ServiceConfig>(p.config)
  if (config?.schemaVersion !== CONFIG_SCHEMA) fail(`namespace not initialized: ${p.config}`)
  return config
}

export function selectedRelease(p: NamespacePaths): ActiveSelection {
  const active = readJson<ActiveSelection>(p.active)
  if (active?.schemaVersion !== ACTIVE_SCHEMA) fail('no release has been activated')
  return active
}

export function initNamespace(nsInput: string, codexPath: string | undefined): unknown {
  const p = namespacePaths(nsInput)
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

/**
 * Record where the daemon logs. Only the config changes: the running daemon
 * keeps its open files, and the next activation (which reloads a supervised
 * job's plist and script) or unsupervised start writes to the new directory.
 */
export function setLogDir(nsInput: string, logDir: string): Record<string, unknown> {
  const p = namespacePaths(nsInput)
  const config = requireConfig(p)
  if (!isAbsolute(logDir)) fail(`log dir must be absolute: ${logDir}`)
  const previous = serviceLogPaths(p.ns, config).dir
  const next: ServiceConfig = { ...config, logDir: resolve(logDir) }
  if (previous !== next.logDir) writeJsonAtomic(p.config, next)
  return { namespace: p.ns, previous, logDir: next.logDir, changed: previous !== next.logDir }
}
