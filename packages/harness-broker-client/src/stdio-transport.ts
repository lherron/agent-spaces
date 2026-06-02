import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { encodeNdjsonFrame } from 'spaces-harness-broker-protocol'
import type { JsonRpcMessage } from 'spaces-harness-broker-protocol'
import { BrokerTransportError } from './errors'
import { type JsonRpcChannelDebugOptions, JsonRpcFramedChannel } from './json-rpc-channel'

export interface StdioTransportStartOptions {
  command: string
  args?: string[] | undefined
  cwd?: string | undefined
  env?: Record<string, string> | undefined
  /** Optional diagnostics hooks for the underlying JSON-RPC channel. */
  debug?: JsonRpcChannelDebugOptions | undefined
}

/** Default grace period before escalating SIGTERM to SIGKILL on close. */
const DEFAULT_CLOSE_GRACE_MS = 500
/** Cap on the captured stderr tail used to enrich a broker failure. */
const STDERR_TAIL_LIMIT = 4096

export class StdioTransport extends JsonRpcFramedChannel {
  readonly child: ChildProcessWithoutNullStreams

  #exitPromise: Promise<void>
  #resolveExit!: () => void
  #stderrTail = ''

  private constructor(child: ChildProcessWithoutNullStreams, debug?: JsonRpcChannelDebugOptions) {
    super(debug)
    this.child = child
    this.#exitPromise = new Promise<void>((resolve) => {
      this.#resolveExit = resolve
    })

    child.stdout.on('data', (chunk: Buffer | string) => {
      this.ingest(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#appendStderr(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    })
    child.once('error', (error) => {
      this.#failExit(new BrokerTransportError('Broker process error', error))
    })
    child.once('exit', (code, signal) => {
      const detail =
        signal !== null ? `signal ${signal}` : `exit code ${code === null ? 'unknown' : code}`
      const message = this.closed
        ? `Broker process closed with ${detail}`
        : `Broker process exited with ${detail}`
      this.#failExit(new BrokerTransportError(message))
    })
  }

  static async start(options: StdioTransportStartOptions): Promise<StdioTransport> {
    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })

    return new StdioTransport(child, options.debug)
  }

  async close(options: { graceMs?: number | undefined } = {}): Promise<void> {
    if (this.closed) {
      return this.#exitPromise
    }

    this.closed = true
    this.rejectPending(new BrokerTransportError('Broker transport closed'))

    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return this.#exitPromise
    }

    const graceMs = options.graceMs ?? DEFAULT_CLOSE_GRACE_MS
    this.child.stdin.end()
    this.child.kill('SIGTERM')

    const exited = await Promise.race([
      this.#exitPromise.then(() => true),
      new Promise<false>((resolve) => {
        setTimeout(() => resolve(false), graceMs)
      }),
    ])

    if (!exited && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill('SIGKILL')
      await this.#exitPromise
    }
  }

  protected writeFrame(message: JsonRpcMessage): void {
    if (this.failure) {
      throw this.failure
    }
    if (this.child.stdin.destroyed) {
      throw new BrokerTransportError('Broker stdin is closed')
    }
    this.child.stdin.write(encodeNdjsonFrame(message))
  }

  #appendStderr(chunk: string): void {
    this.#stderrTail = `${this.#stderrTail}${chunk}`.slice(-STDERR_TAIL_LIMIT)
  }

  /**
   * Latch the broker failure, enriching it with the captured stderr tail, then
   * resolve the exit promise so {@link close} can settle.
   */
  #failExit(error: BrokerTransportError): void {
    const tail = this.#stderrTail.trim()
    const enriched =
      tail.length > 0
        ? new BrokerTransportError(`${error.message}\nBroker stderr:\n${tail}`)
        : error
    this.fail(enriched)
    this.#resolveExit()
  }
}
