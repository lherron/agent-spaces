/**
 * `aspd`: the ASPC compile plane served from one immutable ASP release on a
 * stable Unix socket (T-08539, docs/aspd.md).
 *
 * Preparation only. Compile methods come from `registerAspcCompileMethods`;
 * health, version and surface describe this process. There is no broker or
 * invocation start route. Clients host workers from the release reported here.
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
import { appendFile, unlink } from 'node:fs/promises'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { Writable } from 'node:stream'
import { recordCompilePhases } from 'agent-spaces'
import type { AspcMethodServer, AspcService } from 'spaces-aspc'
import {
  ASPC_COMPILE_METHODS,
  AspcInspectionAuthorityError,
  createAspcService,
  registerAspcCompileMethods,
} from 'spaces-aspc'
import { ASPC_PROTOCOL_VERSION } from 'spaces-aspc-protocol'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
  AspcHelloRequest,
  AspcHelloResponse,
} from 'spaces-aspc-protocol'
import {
  type UsageMetrics,
  configureUsageMetricsHost,
  usageMetrics,
  usageMetricsLabel,
} from 'spaces-config/usage-metrics'
import { BrokerError } from 'spaces-harness-broker'
import type { AspReleaseIdentity, JsonRpcError } from 'spaces-harness-broker-protocol'
import type { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { type ProtocolServer, createProtocolServer } from 'spaces-harness-broker/protocol-server'
import packageManifest from '../package.json'
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
  releaseIdentity?: AspReleaseIdentity | undefined
  /**
   * Usage metrics (`aspd-<day>.ndjson`): one `request` row per minute per
   * (op, client, outcome) and one `connection` row per minute per client.
   * Additive to the L3 `rpc.request` line, which stays unchanged.
   */
  metrics?: UsageMetrics | undefined
}

const ASPD_OP_SUMMARIES: Record<
  (typeof ASPC_COMPILE_METHODS)[keyof typeof ASPC_COMPILE_METHODS],
  string
> = {
  'aspc.hello': 'Negotiate the compile interface and report the serving release.',
  'aspc.catalogAgents': 'List agents visible in an evaluation context.',
  'aspc.inspectAgent': 'Inspect an agent with an explicit evaluation context.',
  'aspc.catalogAgentInspection': 'List agent inspection selections.',
  'aspc.inspectAgentSelection': 'Inspect a selected agent declaration.',
  'aspc.compileHarnessInvocation':
    'Compile and materialize a harness invocation without starting it.',
  'aspc.resolveRuntimeDeclaration': 'Resolve a runtime declaration from its context.',
  'aspc.inspectRuntimePlacement': 'Inspect declared runtime placement intent.',
  'aspc.observeRuntimeCapability': 'Observe a runtime harness capability.',
  'aspc.observeContinuationArtifact': 'Inspect a continuation artifact.',
  'aspc.prepareProcessInvocation': 'Prepare process launch inputs without starting a process.',
}

/** Discovery has no params. Existing compile params retain their wire contract. */
function requireEmptyDiscoveryParams(params: unknown): void {
  const record = asRecord(params)
  if (params === undefined || (record !== undefined && Object.keys(record).length === 0)) return
  const keys = record === undefined ? [] : Object.keys(record)
  throw new BrokerError(
    -32602 as BrokerErrorCode,
    keys.length > 0
      ? `Unknown params: ${keys.join(', ')}. Call with params: {}.`
      : 'Params must be an empty object. Call with params: {}.'
  )
}

/** 16 MiB excludes the LF delimiter; checked before buffering or parsing. */
export const ASPD_MAX_FRAME_BYTES = 16 * 1024 * 1024

/** Numeric JSON-RPC codes, messages and existing structured data remain intact. */
function adviseAspdError(error: JsonRpcError, method: string): JsonRpcError {
  const data = asRecord(error.data) ?? {}
  const reason =
    typeof data['reason'] === 'string'
      ? data['reason']
      : error.code === -32601
        ? 'op_unknown'
        : error.code === -32602
          ? 'invalid_params'
          : error.code === -32700
            ? 'parse_error'
            : 'internal_error'
  const advice =
    reason === 'op_unknown'
      ? 'Call surface with params: {} to list valid operations.'
      : reason === 'frame_too_large'
        ? `Send one JSON-RPC request of at most ${ASPD_MAX_FRAME_BYTES} UTF-8 bytes followed by LF; call health with params: {} to check recovery.`
        : reason === 'empty_frame' || reason === 'parse_error'
          ? 'Send a JSON-RPC object followed by LF, for example {"jsonrpc":"2.0","id":1,"method":"health","params":{}}.'
          : reason === 'invalid_params'
            ? `Correct the named params issues and call ${method} again; call surface with params: {} to list operations.`
            : `Retry ${method} with the same params (compile service calls are idempotent); call health with params: {} if the failure persists.`
  return { ...error, data: { ...data, reason, advice } }
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

type AspdLogLevel = 'debug' | 'info' | 'warn' | 'error'

/**
 * One aspd log line in the collective's L2 shape (references/logging.md):
 * `{ts, level, component, event, data}`, `data` omitted when empty.
 */
export function formatAspdLogLine(
  level: AspdLogLevel,
  component: string,
  event: string,
  data: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    ts: new Date().toISOString(),
    level,
    component,
    event,
    ...(Object.keys(data).length > 0 ? { data } : {}),
  })
}

/** A Writable that turns raw text written to it into L2 lines on `log`. */
function l2Stream(log: (line: string) => void, event: string): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      const text = String(chunk).trimEnd()
      if (text !== '') log(formatAspdLogLine('error', 'rpc', event, { message: text }))
      callback()
    },
  })
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

const MAX_LOGGED_ERROR_CHARS = 2000

function clipError(message: string): string {
  return message.length > MAX_LOGGED_ERROR_CHARS
    ? `${message.slice(0, MAX_LOGGED_ERROR_CHARS)}…`
    : message
}

/** The first diagnostic message of an ok:false result body, for the request log. */
function resultError(result: unknown): string | undefined {
  const record = asRecord(result)
  if (record?.['ok'] !== false) return undefined
  const diagnostics = record['diagnostics']
  const first = Array.isArray(diagnostics) ? asRecord(diagnostics[0]) : undefined
  const resolution = asRecord(record['resolution'])
  const message = first?.['message'] ?? resolution?.['message'] ?? record['message']
  return typeof message === 'string' ? clipError(message) : undefined
}

function thrownError(error: unknown): string {
  return clipError(error instanceof Error ? error.message : String(error))
}

function errorOutcome(error: unknown): string {
  if (error instanceof BrokerError) return `error:${String(error.code)}`
  const code = asRecord(error)?.['code']
  return `error:${typeof code === 'string' || typeof code === 'number' ? String(code) : 'exception'}`
}

/** Reply sizes already measured by the gated handler, so metrics never re-serialize a compile result. */
const measuredReplyBytes = new WeakMap<object, number>()

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
  const { metrics } = options
  const slowRequestMs = options.slowRequestMs ?? ASPD_SLOW_REQUEST_MS
  const { socketPath } = options
  let admitting = true
  let inFlight = 0
  let drained: (() => void) | undefined
  const connections = new Map<Socket, ProtocolServer>()
  let nextConnection = 1
  const surface = new Map<string, { op: string; summary: string; stream: boolean }>()

  await reclaimStaleSocket(socketPath)

  const netServer: Server = createServer((socket) => {
    const connectionId = nextConnection++
    if (!admitting) {
      socket.destroy()
      return
    }
    // One connection row per close: how many requests each connection carried
    // (the hello-per-call pattern), keyed by the first client name it sent.
    const usage = { requests: 0, client: 'unknown' }
    const server = createProtocolServer({
      stdin: socket,
      stdout: socket,
      // The protocol server's own diagnostics become L2 lines, never raw text.
      stderr: l2Stream(log, 'rpc.observe-failed'),
      maxFrameBytes: ASPD_MAX_FRAME_BYTES,
      rejectEmptyFrames: true,
      decorateError: adviseAspdError,
      onRequestComplete(completion) {
        const resultStatus = resultOutcome(completion.result)
        const outcome =
          completion.error !== undefined
            ? String(completion.error.code)
            : resultStatus.startsWith('rejected:')
              ? resultStatus.slice('rejected:'.length)
              : 'ok'
        const message = completion.error?.message ?? resultError(completion.result)
        log(
          JSON.stringify({
            ts: new Date().toISOString(),
            level: outcome === 'ok' ? 'info' : completion.error?.code === -32603 ? 'error' : 'warn',
            component: 'rpc',
            event: 'rpc.request',
            data: {
              listener: 'aspd',
              op: completion.method,
              client: completion.client,
              durationMs: round1(completion.durationMs),
              outcome,
              ...(message === undefined ? {} : { code: outcome, message: clipError(message) }),
            },
          })
        )
        if (metrics !== undefined) {
          const client = usageMetricsLabel(completion.client)
          usage.requests += 1
          if (usage.client === 'unknown') usage.client = client
          const bytes =
            completion.error !== undefined
              ? replyBytes(completion.error)
              : ((typeof completion.result === 'object' && completion.result !== null
                  ? measuredReplyBytes.get(completion.result)
                  : undefined) ?? replyBytes(completion.result))
          metrics.count(
            'request',
            { op: completion.method, client, outcome },
            {
              ms: completion.durationMs,
              ...(bytes === undefined ? {} : { replyBytes: bytes }),
            }
          )
        }
      },
    })
    const gated: AspcMethodServer = {
      register(method, handler) {
        const summary = ASPD_OP_SUMMARIES[method as keyof typeof ASPD_OP_SUMMARIES]
        if (summary === undefined) throw new Error(`Missing aspd surface summary for ${method}`)
        surface.set(method, { op: method, summary, stream: false })
        server.register(method, async (request) => {
          // Checked at dispatch, not at read: a frame already buffered when
          // retirement began is never admitted into this release.
          if (!admitting) {
            log(
              formatAspdLogLine('warn', 'rpc', 'request.refused-retiring', {
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
              formatAspdLogLine('info', 'rpc', 'request.admitted', {
                ...base,
                startedAt: startedAt.toISOString(),
              })
            )
          }
          const slowTimer = setTimeout(() => {
            log(
              formatAspdLogLine('warn', 'rpc', 'request.slow', {
                ...base,
                startedAt: startedAt.toISOString(),
                elapsedMs: round1(performance.now() - startedMs),
                slowRequestMs,
              })
            )
          }, slowRequestMs)
          slowTimer.unref?.()
          let outcome = 'ok'
          let errorText: string | undefined
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
            errorText = resultError(result)
            bytes = replyBytes(result)
            if (bytes !== undefined && typeof result === 'object' && result !== null) {
              measuredReplyBytes.set(result, bytes)
            }
            return result
          } catch (error) {
            outcome = errorOutcome(error)
            errorText = thrownError(error)
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
                  durationMs >= slowRequestMs ? 'warn' : 'info',
                  'rpc',
                  'request.answered',
                  {
                    ...base,
                    startedAt: startedAt.toISOString(),
                    durationMs,
                    outcome,
                    ...(errorText !== undefined ? { error: errorText } : {}),
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
    const discovery = {
      health: {
        summary: 'Report process health without checking dependencies.',
        handle: () => ({ ok: true, degraded: [] }),
      },
      version: {
        summary: 'Report the build, interface version and capabilities.',
        handle: () => ({
          buildVersion: options.releaseIdentity?.releaseId ?? packageManifest.version,
          interfaceVersion: ASPC_PROTOCOL_VERSION,
          capabilities: {
            health: true,
            version: true,
            surface: true,
            ...Object.fromEntries(Object.values(ASPC_COMPILE_METHODS).map((op) => [op, true])),
          },
          ...(options.releaseIdentity === undefined ? {} : { release: options.releaseIdentity }),
        }),
      },
      surface: {
        summary: 'List the registered operations and their summaries.',
        handle: () => ({ schemaVersion: 'aspd-surface/v1', ops: [...surface.values()] }),
      },
    }
    for (const [op, entry] of Object.entries(discovery)) {
      surface.set(op, { op, summary: entry.summary, stream: false })
      server.register(op, async ({ params }) => {
        requireEmptyDiscoveryParams(params)
        return entry.handle()
      })
    }
    connections.set(socket, server)
    void server.start()
    let closed = false
    const cleanup = (): void => {
      connections.delete(socket)
      void server.close()
      if (closed) return
      closed = true
      metrics?.count('connection', { client: usage.client }, { requests: usage.requests })
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
  log(formatAspdLogLine('info', 'rpc', 'rpc.listen', { listener: 'aspd', address: socketPath }))

  return {
    inFlight: () => inFlight,
    async retire(): Promise<void> {
      if (!admitting) return
      admitting = false
      log(
        formatAspdLogLine('info', 'aspd', 'retire.begin', {
          inFlight,
          connections: connections.size,
        })
      )
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
      log(formatAspdLogLine('info', 'aspd', 'retire.drained'))
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
 * aspd's own log (T-08787). Lines are buffered and appended asynchronously on
 * a short interval so the request path never blocks on disk. Every flush opens
 * the file for append (O_APPEND), so the collective's copytruncate rotation
 * (logging standard L4) leaves no offset gap: the next write lands at the new
 * end. aspd does not rotate its own log. `flushSync` covers process exit so a
 * clean shutdown or crash loses nothing that was buffered.
 */
export interface AspdFileLog {
  write(line: string): void
  flush(): Promise<void>
  flushSync(): void
  close(): Promise<void>
}

export interface AspdFileLogOptions {
  path: string
  flushIntervalMs?: number | undefined
  maxBufferedBytes?: number | undefined
}

export function createAspdFileLog(options: AspdFileLogOptions): AspdFileLog {
  const { path } = options
  const maxBufferedBytes = options.maxBufferedBytes ?? 8 * 1024 * 1024
  let pending: string[] = []
  let pendingBytes = 0
  let dropped = 0
  let flushing: Promise<void> | undefined

  const take = (): string | undefined => {
    if (dropped > 0) {
      pending.push(formatAspdLogLine('warn', 'log', 'log.dropped', { lines: dropped }))
      dropped = 0
    }
    if (pending.length === 0) return undefined
    const chunk = `${pending.join('\n')}\n`
    pending = []
    pendingBytes = 0
    return chunk
  }

  const flushOnce = async (): Promise<void> => {
    const chunk = take()
    if (chunk === undefined) return
    try {
      await appendFile(path, chunk)
    } catch (error) {
      process.stderr.write(
        `${formatAspdLogLine('error', 'log', 'log.write_failed', { path, error: String(error) })}\n`
      )
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

/**
 * The Praesidium var root of a namespaced release (`<var>/aspd/releases/<id>`):
 * the namespace's parent, as `just install` lays it out (repo/../var/aspd).
 * Undefined for a release outside a namespace; the writer then falls back to
 * its default.
 */
export function aspdVarRoot(releaseRoot: string): string | undefined {
  const releases = dirname(releaseRoot)
  return basename(releases) === 'releases' ? dirname(dirname(releases)) : undefined
}

export interface RunAspdCliOptions {
  releaseIdentity?: AspReleaseIdentity | undefined
}

const ASPD_USAGE = 'aspd serve --socket <absolute-path> [--log <absolute-path>]'

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

/** `aspd serve --socket <path> [--log <path>]`: the release entrypoint's command surface. */
export async function runAspdCli(args: string[], options: RunAspdCliOptions): Promise<void> {
  // aspd is a supervised daemon: even a refused invocation is an L2 line on
  // stderr (the supervisor's file), never raw text.
  const refuseUsage = (): never => {
    process.stderr.write(
      `${formatAspdLogLine('error', 'aspd', 'aspd.usage', { usage: ASPD_USAGE, args })}\n`
    )
    process.exit(1)
  }
  const [command, ...rest] = args
  if (command !== 'serve') refuseUsage()
  const socketPath = flagValue(rest, '--socket')
  const logPath = flagValue(rest, '--log')
  if (
    socketPath === undefined ||
    !socketPath.startsWith('/') ||
    (rest.includes('--log') && (logPath === undefined || !logPath.startsWith('/')))
  ) {
    refuseUsage()
  }
  const fileLog = logPath === undefined ? undefined : createAspdFileLog({ path: logPath })
  const log = fileLog
    ? (line: string) => fileLog.write(line)
    : (line: string) => process.stderr.write(`${line}\n`)
  // Lifecycle lines also go synchronously to stderr (the supervisor's file),
  // so starts, exits and fatal errors stay visible there.
  const lifecycle = (level: AspdLogLevel, event: string, fields: Record<string, unknown>) => {
    const line = formatAspdLogLine(level, 'aspd', event, fields)
    process.stderr.write(`${line}\n`)
    fileLog?.write(line)
  }
  if (fileLog) process.on('exit', () => fileLog.flushSync())
  const fatal = (error: unknown): never => {
    lifecycle('error', 'aspd.fatal', {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    })
    process.exit(1)
  }
  process.on('uncaughtException', fatal)
  process.on('unhandledRejection', fatal)
  try {
    await serve(socketPath as string, logPath, options, log, lifecycle, fileLog)
  } catch (error) {
    // A startup failure (release binding, socket already served) is fatal too.
    fatal(error)
  }
}

async function serve(
  socketPath: string,
  logPath: string | undefined,
  options: RunAspdCliOptions,
  log: (line: string) => void,
  lifecycle: (level: AspdLogLevel, event: string, fields: Record<string, unknown>) => void,
  fileLog: AspdFileLog | undefined
): Promise<void> {
  const binding = resolveAspdReleaseBinding(options.releaseIdentity, process.execPath)
  // Metrics warnings are L2 lines in aspd's own log, never raw stderr text.
  configureUsageMetricsHost({
    product: `aspd/${binding.identity.releaseId}`,
    varRoot: aspdVarRoot(binding.releaseRoot),
    warn: (event, data) => log(formatAspdLogLine('warn', 'metrics', event, data)),
  })
  const service = createAspdService(binding)
  const server = await startAspdServer({
    socketPath,
    service,
    log,
    releaseIdentity: binding.identity,
    metrics: usageMetrics('aspd'),
  })
  lifecycle('info', 'aspd.serving', {
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
      lifecycle('info', 'aspd.exit', { release: binding.identity.releaseId })
      await fileLog?.close()
      process.exit(0)
    })
  }
  process.on('SIGTERM', retire)
  process.on('SIGINT', retire)
}
