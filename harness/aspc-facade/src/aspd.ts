/**
 * `aspd`: the ASPC compile plane served from one immutable ASP release on a
 * stable Unix socket (T-08539, docs/aspd.md).
 *
 * Preparation only. It registers the existing seven `aspc.*` methods through
 * `registerAspcCompileMethods` and nothing else: no `aspc.compileAndStart`, no
 * broker, no invocation routes. Workers are hosted by the client from the
 * release this daemon reports.
 *
 * Activation retires a daemon with SIGTERM: admission stops on the listener AND
 * on every existing connection before in-flight requests drain, so a connection
 * opened before activation can never admit work into the retiring release.
 */
import {
  constants,
  accessSync,
  appendFileSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { appendFile, rename, stat, unlink } from 'node:fs/promises'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { recordCompilePhases } from 'agent-spaces'
import type { AspcMethodServer, AspcService } from 'spaces-aspc'
import {
  AspcInspectionAuthorityError,
  createAspcService,
  registerAspcCompileMethods,
} from 'spaces-aspc'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
  AspcHelloRequest,
  AspcHelloResponse,
} from 'spaces-aspc-protocol'
import { BrokerError } from 'spaces-harness-broker'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'
import type { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { type ProtocolServer, createProtocolServer } from 'spaces-harness-broker/protocol-server'
import { createRuntimeCompiler, runtimeDependencies } from './runtime-compiler.js'

export const ASPD_WORKER_ARGV_PREFIX = ['run', '--transport', 'unix'] as const

/** The release a daemon serves from, verified against its on-disk manifest. */
export interface AspdReleaseBinding {
  identity: AspReleaseIdentity
  releaseRoot: string
  workers: Record<string, { executable: string; hostedDrivers: string[] }>
  claudeStatuslineSource: { path: string; sha256: string; required: true }
}

/**
 * Resolve the release containing `executablePath` (`<root>/libexec/aspd`) and
 * prove its manifest names the compiled-in identity. Refuses rather than
 * guessing: an aspd that cannot name its own release has nothing to bind.
 */
export function resolveAspdReleaseBinding(
  identity: AspReleaseIdentity | undefined,
  executablePath: string
): AspdReleaseBinding {
  if (identity === undefined) {
    throw new Error('aspd must run from an immutable ASP release: no compiled-in release identity')
  }
  const payload = realpathSync(executablePath)
  const releaseRoot = dirname(dirname(payload))
  if (basename(dirname(payload)) !== 'libexec' || basename(releaseRoot) !== identity.releaseId) {
    throw new Error(`aspd payload is not inside release ${identity.releaseId}: ${payload}`)
  }
  const manifest = JSON.parse(readFileSync(join(releaseRoot, 'release.json'), 'utf8')) as {
    releaseId?: unknown
    sourceCommit?: unknown
    executables?: Record<string, { launcher?: unknown } | undefined>
    workerBindings?: Record<string, unknown> | undefined
    assets?: Record<string, { path?: unknown; sha256?: unknown } | undefined> | undefined
  }
  if (
    manifest.releaseId !== identity.releaseId ||
    manifest.sourceCommit !== identity.sourceCommit
  ) {
    throw new Error(`release manifest does not match compiled-in identity ${identity.releaseId}`)
  }
  if (
    typeof manifest.workerBindings !== 'object' ||
    manifest.workerBindings === null ||
    Array.isArray(manifest.workerBindings)
  ) {
    throw new Error(`release ${identity.releaseId} has no worker binding table`)
  }
  const workers: AspdReleaseBinding['workers'] = {}
  const hostedByExecutable = new Map<string, string[]>()
  for (const [driver, executableName] of Object.entries(manifest.workerBindings)) {
    if (typeof executableName !== 'string') {
      throw new Error(`release ${identity.releaseId} has invalid worker binding for ${driver}`)
    }
    const launcher = manifest.executables?.[executableName]?.launcher
    if (typeof launcher !== 'string') {
      throw new Error(`release ${identity.releaseId} binding ${driver} has no worker executable`)
    }
    const workerExecutable = realpathSync(join(releaseRoot, launcher))
    if (!workerExecutable.startsWith(`${releaseRoot}${sep}`)) {
      throw new Error(`worker executable escapes release ${identity.releaseId}`)
    }
    accessSync(workerExecutable, constants.X_OK)
    const hostedDrivers = hostedByExecutable.get(workerExecutable) ?? []
    hostedDrivers.push(driver)
    hostedByExecutable.set(workerExecutable, hostedDrivers)
    workers[driver] = { executable: workerExecutable, hostedDrivers }
  }
  for (const hostedDrivers of hostedByExecutable.values()) hostedDrivers.sort()

  const statusline = manifest.assets?.['claude-statusline']
  if (typeof statusline?.path !== 'string' || typeof statusline.sha256 !== 'string') {
    throw new Error(`release ${identity.releaseId} has no Claude statusline asset`)
  }
  const statuslinePath = resolve(releaseRoot, statusline.path)
  if (!statuslinePath.startsWith(`${releaseRoot}${sep}`)) {
    throw new Error(`Claude statusline asset escapes release ${identity.releaseId}`)
  }
  return {
    identity: { ...identity },
    releaseRoot,
    workers,
    claudeStatuslineSource: { path: statuslinePath, sha256: statusline.sha256, required: true },
  }
}

/**
 * Report the unix transport and the serving release, and attach the release
 * binding to successful harness-invocation compiles. Everything the underlying
 * service returns is passed through unchanged.
 */
export function createReleaseBoundAspcService(
  service: AspcService,
  binding: AspdReleaseBinding
): AspcService {
  return {
    ...service,
    async hello(req: AspcHelloRequest): Promise<AspcHelloResponse> {
      const response = await service.hello(req)
      return {
        ...response,
        capabilities: {
          ...response.capabilities,
          cohostedBroker: false,
          transports: ['unix-jsonrpc-ndjson'],
        },
        release: { ...binding.identity },
      }
    },
    async compileHarnessInvocation(
      req: AspcCompileHarnessInvocationRequest
    ): Promise<AspcCompileHarnessInvocationResponse> {
      const response = await service.compileHarnessInvocation(req)
      if (!response.ok) return response
      const brokerDriver = response.plan.execution.driver
      const worker = binding.workers[brokerDriver]
      if (worker === undefined) {
        const diagnostic = {
          level: 'error' as const,
          code: 'release_worker_driver_unavailable',
          message: 'Selected broker driver is not hosted by this ASP release',
          plane: 'asp-compiler' as const,
          details: { releaseId: binding.identity.releaseId, brokerDriver },
        }
        const diagnostics = [...response.diagnostics, diagnostic]
        return {
          schemaVersion: response.schemaVersion,
          ok: false,
          diagnostics,
        }
      }
      const executionRelease: AspcExecutionRelease = {
        ...binding.identity,
        releaseRoot: binding.releaseRoot,
        worker: {
          protocol: response.plan.execution.protocol,
          executable: worker.executable,
          hostedDrivers: [...worker.hostedDrivers],
          argvPrefix: [...ASPD_WORKER_ARGV_PREFIX],
        },
      }
      return { ...response, executionRelease }
    },
    async prepareProcessInvocation(req) {
      const response = await service.prepareProcessInvocation(req)
      if (response['ok'] !== true) return response
      return {
        ...response,
        release: { ...binding.identity, releaseRoot: binding.releaseRoot },
      }
    },
  }
}

/** Compose the standalone daemon's compiler and execution dependencies once. */
export function createAspdService(binding: AspdReleaseBinding): AspcService {
  return createReleaseBoundAspcService(
    createAspcService({
      compiler: createRuntimeCompiler({ claudeStatuslineSource: binding.claudeStatuslineSource }),
      runtimeDependencies,
    }),
    binding
  )
}

export interface AspdServerOptions {
  socketPath: string
  service: AspcService
  log?: ((line: string) => void) | undefined
  /** In-flight requests older than this log `request.slow` (default 2000ms). */
  slowRequestMs?: number | undefined
}

export const ASPD_SLOW_REQUEST_MS = 2_000

/**
 * Launch-path methods also log `request.admitted`, so an in-flight launch is
 * visible before it answers. The hello/observation churn (≈99.9% of requests)
 * logs only its answered line.
 */
const ADMISSION_LOGGED_METHODS = new Set([
  'aspc.compileHarnessInvocation',
  'aspc.prepareProcessInvocation',
])

/** Methods whose answered line carries compiler phase timings. */
const PHASED_METHODS = new Set(['aspc.compileHarnessInvocation'])

type AspdLogLevel = 'INFO' | 'WARN' | 'ERROR'

/** One aspd log line, HRC-style: `<iso> [aspd] <LEVEL> <event> <json fields>`. */
export function formatAspdLogLine(
  level: AspdLogLevel,
  event: string,
  fields: Record<string, unknown> = {}
): string {
  return `${new Date().toISOString()} [aspd] ${level} ${event} ${JSON.stringify(fields)}`
}

/**
 * Caller correlation read from request params, never required. HRC's
 * `broker.timing precompile-compile-rpc` line logs the same runtimeId it
 * allocates into `compileRequest.identity`.
 */
function requestCorrelation(params: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const record = asRecord(params)
  const compileRequest = asRecord(record?.['compileRequest'])
  const identity = asRecord(compileRequest?.['identity'])
  for (const key of ['runtimeId', 'traceId', 'invocationId'] as const) {
    const value = identity?.[key]
    if (typeof value === 'string') out[key] = value
  }
  const scopeRef = compileRequest?.['scopeRef']
  if (typeof scopeRef === 'string') out['scopeRef'] = scopeRef
  const agentId = asRecord(record?.['context'])?.['agentId']
  if (typeof agentId === 'string') out['agentId'] = agentId
  return out
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** ok | rejected:<first diagnostic code> for an ok:false result body. */
function resultOutcome(result: unknown): string {
  const record = asRecord(result)
  if (record?.['ok'] !== false) return 'ok'
  const diagnostics = record['diagnostics']
  const first = Array.isArray(diagnostics) ? asRecord(diagnostics[0]) : undefined
  const resolution = asRecord(record['resolution'])
  const code = first?.['code'] ?? resolution?.['code'] ?? record['code']
  return `rejected:${typeof code === 'string' ? code : 'unknown'}`
}

function errorOutcome(error: unknown): string {
  if (error instanceof BrokerError) return `error:${String(error.code)}`
  const code = asRecord(error)?.['code']
  return `error:${typeof code === 'string' || typeof code === 'number' ? String(code) : 'exception'}`
}

function replyBytes(result: unknown): number | undefined {
  try {
    const json = JSON.stringify(result)
    return json === undefined ? undefined : Buffer.byteLength(json)
  } catch {
    return undefined
  }
}

const round1 = (ms: number): number => Math.round(ms * 10) / 10

export interface AspdServer {
  /** Requests admitted and not yet answered. */
  inFlight(): number
  /**
   * Stop admitting on the listener and every connection, remove the socket
   * node, wait for in-flight requests to reply, then close all connections.
   */
  retire(): Promise<void>
}

const NEVER_ADMITTED = new Promise<never>(() => {})

export async function startAspdServer(options: AspdServerOptions): Promise<AspdServer> {
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const slowRequestMs = options.slowRequestMs ?? ASPD_SLOW_REQUEST_MS
  const { socketPath } = options
  let admitting = true
  let inFlight = 0
  let drained: (() => void) | undefined
  const connections = new Map<Socket, ProtocolServer>()
  let nextConnection = 1

  await reclaimStaleSocket(socketPath)

  const netServer: Server = createServer((socket) => {
    const connectionId = nextConnection++
    if (!admitting) {
      socket.destroy()
      return
    }
    const server = createProtocolServer({ stdin: socket, stdout: socket, stderr: process.stderr })
    const gated: AspcMethodServer = {
      register(method, handler) {
        server.register(method, async (request) => {
          // Checked at dispatch, not at read: a frame already buffered when
          // retirement began is never admitted into this release.
          if (!admitting) {
            log(
              formatAspdLogLine('WARN', 'request.refused-retiring', {
                conn: connectionId,
                id: String(request.id),
                method: request.method,
              })
            )
            return NEVER_ADMITTED
          }
          inFlight += 1
          const startedAt = new Date()
          const startedMs = performance.now()
          const base = {
            conn: connectionId,
            id: String(request.id),
            method,
            ...requestCorrelation(request.params),
          }
          if (ADMISSION_LOGGED_METHODS.has(method)) {
            log(
              formatAspdLogLine('INFO', 'request.admitted', {
                ...base,
                startedAt: startedAt.toISOString(),
              })
            )
          }
          const slowTimer = setTimeout(() => {
            log(
              formatAspdLogLine('WARN', 'request.slow', {
                ...base,
                startedAt: startedAt.toISOString(),
                elapsedMs: round1(performance.now() - startedMs),
                slowRequestMs,
              })
            )
          }, slowRequestMs)
          slowTimer.unref?.()
          let outcome = 'ok'
          let bytes: number | undefined
          let phases: Record<string, number> | undefined
          try {
            let result: unknown
            if (PHASED_METHODS.has(method)) {
              const recorded = await recordCompilePhases(() => handler(request))
              result = recorded.result
              phases = recorded.phases
            } else {
              result = await handler(request)
            }
            outcome = resultOutcome(result)
            bytes = replyBytes(result)
            return result
          } catch (error) {
            outcome = errorOutcome(error)
            if (error instanceof AspcInspectionAuthorityError) {
              throw new BrokerError(-32603 as BrokerErrorCode, error.message, {
                code: error.code,
                status: error.status,
              })
            }
            throw error
          } finally {
            clearTimeout(slowTimer)
            const durationMs = round1(performance.now() - startedMs)
            // Count the request as in flight until the protocol server has
            // written its reply frame (it does so in a microtask after this
            // handler settles), so retirement never closes ahead of the reply.
            setImmediate(() => {
              inFlight -= 1
              log(
                formatAspdLogLine(
                  durationMs >= slowRequestMs ? 'WARN' : 'INFO',
                  'request.answered',
                  {
                    ...base,
                    startedAt: startedAt.toISOString(),
                    durationMs,
                    outcome,
                    ...(bytes !== undefined ? { replyBytes: bytes } : {}),
                    ...(phases !== undefined && Object.keys(phases).length > 0 ? { phases } : {}),
                  }
                )
              )
              if (inFlight === 0) drained?.()
            })
          }
        })
      },
    }
    registerAspcCompileMethods(gated, { service: options.service })
    connections.set(socket, server)
    void server.start()
    const cleanup = (): void => {
      connections.delete(socket)
      void server.close()
    }
    socket.once('close', cleanup)
    socket.once('error', cleanup)
  })

  await new Promise<void>((resolve, reject) => {
    netServer.once('error', reject)
    netServer.listen(socketPath, () => {
      netServer.removeListener('error', reject)
      resolve()
    })
  })
  const boundInode = statSync(socketPath).ino

  return {
    inFlight: () => inFlight,
    async retire(): Promise<void> {
      if (!admitting) return
      admitting = false
      log(formatAspdLogLine('INFO', 'retire.begin', { inFlight, connections: connections.size }))
      netServer.close()
      try {
        if (statSync(socketPath).ino === boundInode) await unlink(socketPath)
      } catch {
        // Already gone.
      }
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          drained = resolve
        })
      }
      // Half-close every connection and wait until its buffered replies have
      // flushed and the peer is gone: the process exits when this resolves.
      await Promise.all(
        [...connections].map(
          ([socket, server]) =>
            new Promise<void>((resolve) => {
              const done = (): void => {
                clearTimeout(timer)
                void server.close().then(() => resolve())
              }
              const timer = setTimeout(() => {
                socket.destroy()
              }, 10_000)
              if (socket.destroyed) {
                done()
                return
              }
              socket.once('close', done)
              socket.end()
            })
        )
      )
      log(formatAspdLogLine('INFO', 'retire.drained'))
    },
  }
}

async function reclaimStaleSocket(socketPath: string): Promise<void> {
  try {
    statSync(socketPath)
  } catch {
    return
  }
  const alive = await new Promise<boolean>((resolve) => {
    const probe = connect({ path: socketPath })
    probe.once('connect', () => {
      probe.destroy()
      resolve(true)
    })
    probe.once('error', () => resolve(false))
  })
  if (alive) throw new Error(`aspd socket already served by a live listener: ${socketPath}`)
  await unlink(socketPath).catch(() => {})
}

/**
 * aspd's own bounded log (T-08787). Lines are buffered and appended
 * asynchronously on a short interval so the request path never blocks on disk;
 * rotation (rename to .1..N) happens at flush time. `flushSync` covers process
 * exit so a clean shutdown or crash loses nothing that was buffered.
 */
export interface AspdFileLog {
  write(line: string): void
  flush(): Promise<void>
  flushSync(): void
  close(): Promise<void>
}

export interface AspdFileLogOptions {
  path: string
  maxBytes?: number | undefined
  keep?: number | undefined
  flushIntervalMs?: number | undefined
  maxBufferedBytes?: number | undefined
}

export const ASPD_LOG_MAX_BYTES = 32 * 1024 * 1024
export const ASPD_LOG_KEEP = 3

export function createAspdFileLog(options: AspdFileLogOptions): AspdFileLog {
  const { path } = options
  const maxBytes = options.maxBytes ?? ASPD_LOG_MAX_BYTES
  const keep = options.keep ?? ASPD_LOG_KEEP
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024
  let pending: string[] = []
  let pendingBytes = 0
  let dropped = 0
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    size = 0
  }
  let flushing: Promise<void> | undefined

  const take = (): string | undefined => {
    if (dropped > 0) {
      pending.push(formatAspdLogLine('WARN', 'log.dropped', { lines: dropped }))
      dropped = 0
    }
    if (pending.length === 0) return undefined
    const chunk = `${pending.join('\n')}\n`
    pending = []
    pendingBytes = 0
    return chunk
  }

  const rotate = async (): Promise<void> => {
    for (let n = keep - 1; n >= 1; n--) {
      await rename(`${path}.${n}`, `${path}.${n + 1}`).catch(() => {})
    }
    await rename(path, `${path}.1`).catch(() => {})
    size = 0
  }

  const flushOnce = async (): Promise<void> => {
    const chunk = take()
    if (chunk === undefined) return
    try {
      if (size >= maxBytes) await rotate()
      await appendFile(path, chunk)
      size += Buffer.byteLength(chunk)
    } catch (error) {
      process.stderr.write(
        `${formatAspdLogLine('ERROR', 'log.write_failed', { path, error: String(error) })}\n`
      )
      // Re-sync the size from disk (a rotation may have half-completed).
      size = await stat(path)
        .then((st) => st.size)
        .catch(() => 0)
    }
  }

  const flush = (): Promise<void> => {
    flushing ??= flushOnce().finally(() => {
      flushing = undefined
    })
    return flushing
  }

  const timer = setInterval(() => void flush(), options.flushIntervalMs ?? 250)
  timer.unref?.()

  return {
    write(line) {
      const bytes = Buffer.byteLength(line) + 1
      if (pendingBytes + bytes > maxBufferedBytes) {
        dropped += 1
        return
      }
      pending.push(line)
      pendingBytes += bytes
    },
    async flush() {
      await flush()
      // A write may have landed while the previous flush was in progress.
      if (pending.length > 0 || dropped > 0) await flush()
    },
    flushSync() {
      const chunk = take()
      if (chunk === undefined) return
      try {
        appendFileSync(path, chunk)
        size += Buffer.byteLength(chunk)
      } catch {
        process.stderr.write(chunk)
      }
    },
    async close() {
      clearInterval(timer)
      await this.flush()
    },
  }
}

export interface RunAspdCliOptions {
  releaseIdentity?: AspReleaseIdentity | undefined
}

const ASPD_USAGE = 'Usage: aspd serve --socket <absolute-path> [--log <absolute-path>]\n'

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** `aspd serve --socket <path> [--log <path>]`: the release entrypoint's command surface. */
export async function runAspdCli(args: string[], options: RunAspdCliOptions): Promise<void> {
  const [command, ...rest] = args
  if (command !== 'serve') {
    process.stderr.write(ASPD_USAGE)
    process.exit(1)
  }
  const socketPath = flagValue(rest, '--socket')
  const logPath = flagValue(rest, '--log')
  if (
    socketPath === undefined ||
    !socketPath.startsWith('/') ||
    (rest.includes('--log') && (logPath === undefined || !logPath.startsWith('/')))
  ) {
    process.stderr.write(ASPD_USAGE)
    process.exit(1)
  }
  const fileLog = logPath === undefined ? undefined : createAspdFileLog({ path: logPath })
  const log = fileLog
    ? (line: string) => fileLog.write(line)
    : (line: string) => process.stderr.write(`${line}\n`)
  // Lifecycle lines also go synchronously to stderr (the supervisor's file),
  // so starts, exits and fatal errors stay visible there.
  const lifecycle = (level: AspdLogLevel, event: string, fields: Record<string, unknown>) => {
    const line = formatAspdLogLine(level, event, fields)
    process.stderr.write(`${line}\n`)
    fileLog?.write(line)
  }
  if (fileLog) {
    process.on('exit', () => fileLog.flushSync())
    process.on('uncaughtException', (error) => {
      lifecycle('ERROR', 'fatal', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      })
      process.exit(1)
    })
  }
  const binding = resolveAspdReleaseBinding(options.releaseIdentity, process.execPath)
  const service = createAspdService(binding)
  const server = await startAspdServer({ socketPath, service, log })
  lifecycle('INFO', 'serving', {
    release: binding.identity.releaseId,
    sourceCommit: binding.identity.sourceCommit,
    socket: socketPath,
    pid: process.pid,
    ...(logPath !== undefined ? { log: logPath } : {}),
  })
  let retiring = false
  const retire = (): void => {
    if (retiring) return
    retiring = true
    void server.retire().then(async () => {
      lifecycle('INFO', 'exit', { release: binding.identity.releaseId })
      await fileLog?.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', retire)
  process.on('SIGINT', retire)
}
