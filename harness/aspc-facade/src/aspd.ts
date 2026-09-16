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
import { constants, accessSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { type Server, type Socket, connect, createServer } from 'node:net'
import { basename, dirname, join, sep } from 'node:path'
import type { AspcMethodServer, AspcService } from 'spaces-aspc'
import { createAspcService, registerAspcCompileMethods } from 'spaces-aspc'
import type {
  AspcCompileHarnessInvocationRequest,
  AspcCompileHarnessInvocationResponse,
  AspcExecutionRelease,
  AspcHelloRequest,
  AspcHelloResponse,
} from 'spaces-aspc-protocol'
import type { AspReleaseIdentity } from 'spaces-harness-broker-protocol'
import { type ProtocolServer, createProtocolServer } from 'spaces-harness-broker/protocol-server'
import { runtimeCompiler } from './runtime-compiler.js'

export const ASPD_WORKER_ARGV_PREFIX = ['run', '--transport', 'unix'] as const

/** The release a daemon serves from, verified against its on-disk manifest. */
export interface AspdReleaseBinding {
  identity: AspReleaseIdentity
  releaseRoot: string
  workerExecutable: string
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
  }
  if (
    manifest.releaseId !== identity.releaseId ||
    manifest.sourceCommit !== identity.sourceCommit
  ) {
    throw new Error(`release manifest does not match compiled-in identity ${identity.releaseId}`)
  }
  const launcher = manifest.executables?.['harness-broker']?.launcher
  if (typeof launcher !== 'string') {
    throw new Error(`release ${identity.releaseId} has no harness-broker worker`)
  }
  const workerExecutable = realpathSync(join(releaseRoot, launcher))
  if (!workerExecutable.startsWith(`${releaseRoot}${sep}`)) {
    throw new Error(`worker executable escapes release ${identity.releaseId}`)
  }
  accessSync(workerExecutable, constants.X_OK)
  return { identity: { ...identity }, releaseRoot, workerExecutable }
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
          compileAndStart: false,
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
      const executionRelease: AspcExecutionRelease = {
        ...binding.identity,
        releaseRoot: binding.releaseRoot,
        worker: {
          protocol: response.selectedProfile.brokerProtocol,
          executable: binding.workerExecutable,
          argvPrefix: [...ASPD_WORKER_ARGV_PREFIX],
        },
      }
      return { ...response, executionRelease }
    },
  }
}

export interface AspdServerOptions {
  socketPath: string
  service: AspcService
  log?: ((line: string) => void) | undefined
}

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
            log(`aspd request.refused-retiring conn=${connectionId} method=${request.method}`)
            return NEVER_ADMITTED
          }
          inFlight += 1
          log(
            `aspd request.admitted conn=${connectionId} id=${String(request.id)} method=${method}`
          )
          try {
            return await handler(request)
          } finally {
            // Count the request as in flight until the protocol server has
            // written its reply frame (it does so in a microtask after this
            // handler settles), so retirement never closes ahead of the reply.
            setImmediate(() => {
              inFlight -= 1
              log(
                `aspd request.answered conn=${connectionId} id=${String(request.id)} method=${method}`
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
      log(`aspd retire.begin inFlight=${inFlight} connections=${connections.size}`)
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
      log('aspd retire.drained')
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

export interface RunAspdCliOptions {
  releaseIdentity?: AspReleaseIdentity | undefined
}

/** `aspd serve --socket <path>`: the release entrypoint's command surface. */
export async function runAspdCli(args: string[], options: RunAspdCliOptions): Promise<void> {
  const [command, ...rest] = args
  if (command !== 'serve') {
    process.stderr.write('Usage: aspd serve --socket <absolute-path>\n')
    process.exit(1)
  }
  const socketIndex = rest.indexOf('--socket')
  const socketPath = socketIndex === -1 ? undefined : rest[socketIndex + 1]
  if (socketPath === undefined || !socketPath.startsWith('/')) {
    process.stderr.write('Usage: aspd serve --socket <absolute-path>\n')
    process.exit(1)
  }
  const binding = resolveAspdReleaseBinding(options.releaseIdentity, process.execPath)
  const service = createReleaseBoundAspcService(
    createAspcService({ compiler: runtimeCompiler }),
    binding
  )
  const server = await startAspdServer({ socketPath, service })
  process.stderr.write(
    `aspd serving release=${binding.identity.releaseId} sourceCommit=${binding.identity.sourceCommit} socket=${socketPath} pid=${process.pid}\n`
  )
  let retiring = false
  const retire = (): void => {
    if (retiring) return
    retiring = true
    void server.retire().then(() => {
      process.stderr.write(`aspd exit release=${binding.identity.releaseId}\n`)
      process.exit(0)
    })
  }
  process.on('SIGTERM', retire)
  process.on('SIGINT', retire)
}
