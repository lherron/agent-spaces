import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { join } from 'node:path'
import { brokerProcessEnv } from './helpers'

/**
 * T-08346 packaged-broker IPC smoke.
 *
 * The acceptance suite drives a FIXTURE entry point so it can register a
 * controlled driver and count real `driver.start` effects. That fixture calls
 * `runBrokerCli` from source. This suite instead runs the shipped
 * `bin/harness-broker.js` with `HARNESS_BROKER_USE_DIST=1`, which is the
 * published tarball's own resolution path — so the participant surface is
 * proved on the compiled artifact an installed broker actually executes, not
 * only on the TypeScript sources.
 *
 * Hermetic on purpose: the default driver roster needs real agent binaries and
 * credentials, so this smoke never asks for a successful start. It proves the
 * bootstrap posture, install idempotency and epoch fence, attach refusal before
 * a resident invocation, the durable receipt journal on disk, and that a
 * definitive failure is recorded once and replayed rather than retried.
 */

const repoRoot = new URL('../../..', import.meta.url).pathname
const brokerBin = join(repoRoot, 'harness/harness-broker/bin/harness-broker.js')

const IDENTITY = {
  runtimeId: 'runtime_t08346_packaged',
  hostSessionId: 'host_session_t08346_packaged',
  generation: 2,
  attachEpoch: 1,
  invocationId: 'inv_t08346_packaged',
  startRequestHash: 'start_hash_t08346_packaged',
  selectedProfileHash: 'profile_hash_t08346_packaged',
  attachToken: 'attach_token_t08346_packaged',
}

type RpcFrame =
  | { jsonrpc: '2.0'; id: string; result: unknown }
  | { jsonrpc: '2.0'; id: string | null; error: { code: number; message: string } }
  | { jsonrpc: '2.0'; method: string }

const spawned: Array<{ dir: string; process: ReturnType<typeof Bun.spawn> }> = []
const openSockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  const running = spawned.splice(0)
  await Promise.all(
    running.map(async (entry) => {
      if (entry.process.exitCode === null) entry.process.kill('SIGTERM')
      await entry.process.exited.catch(() => {})
    })
  )
  await Promise.all(running.map((entry) => rm(entry.dir, { recursive: true, force: true })))
})

class Rpc {
  #socket: Socket
  #pending = new Map<string, (frame: RpcFrame) => void>()
  #buffer = ''
  #next = 1

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      this.#buffer += chunk
      let newline = this.#buffer.indexOf('\n')
      while (newline >= 0) {
        const line = this.#buffer.slice(0, newline)
        this.#buffer = this.#buffer.slice(newline + 1)
        if (line.length > 0) {
          const frame = JSON.parse(line) as RpcFrame
          if ('id' in frame && frame.id !== null) {
            const resolve = this.#pending.get(frame.id)
            if (resolve) {
              this.#pending.delete(frame.id)
              resolve(frame)
            }
          }
        }
        newline = this.#buffer.indexOf('\n')
      }
    })
  }

  static connect(socketPath: string): Promise<Rpc> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath })
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.removeListener('error', reject)
        openSockets.add(socket)
        resolve(new Rpc(socket))
      })
    })
  }

  request(method: string, params: unknown): Promise<RpcFrame> {
    const id = `packaged-${this.#next++}`
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      this.#socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }
}

function resultOf(frame: RpcFrame): Record<string, unknown> {
  if ('error' in frame) throw new Error(`unexpected error frame: ${JSON.stringify(frame.error)}`)
  return ('result' in frame ? frame.result : undefined) as Record<string, unknown>
}

function errorOf(frame: RpcFrame): { code: number; message: string } {
  if (!('error' in frame)) throw new Error(`expected an error frame: ${JSON.stringify(frame)}`)
  return frame.error
}

async function startPackagedParticipant(): Promise<{ socketPath: string; ledgerDir: string }> {
  // macOS sockaddr_un is 104 bytes; /tmp keeps the path inside the budget.
  const dir = join('/tmp', `t83pkg-${crypto.randomUUID().slice(0, 8)}`)
  await mkdir(dir, { recursive: true })
  const socketPath = join(dir, 'broker.sock')
  const process_ = Bun.spawn({
    cmd: [
      'bun',
      brokerBin,
      'run',
      '--transport',
      'unix',
      '--socket',
      socketPath,
      '--event-ledger',
      join(dir, 'events.ndjson'),
      '--join',
      'participant-served',
    ],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    // The packaged resolution path: dist, exactly as an installed tarball
    // (which ships no `src`) resolves it.
    env: brokerProcessEnv({ HARNESS_BROKER_USE_DIST: '1' }),
  })
  spawned.push({ dir, process: process_ })

  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (process_.exitCode !== null) {
      throw new Error(
        `packaged broker exited before bind: ${(await new Response(process_.stderr).text()).trim()}`
      )
    }
    try {
      if ((await stat(socketPath)).isSocket()) return { socketPath, ledgerDir: dir }
    } catch {
      // not bound yet
    }
    await Bun.sleep(25)
  }
  throw new Error('packaged broker did not bind its unix socket')
}

describe('T-08346 packaged broker participant IPC', () => {
  test('the shipped dist entry point serves the participant establishment surface', async () => {
    const { socketPath, ledgerDir } = await startPackagedParticipant()
    const rpc = await Rpc.connect(socketPath)

    // 1. Bootstrap posture: only installIdentity.
    expect(
      errorOf(
        await rpc.request('broker.hello', {
          clientInfo: { name: 't08346-packaged' },
          protocolVersions: ['harness-broker/0.3'],
        })
      ).message
    ).toMatch(/bootstrap|install.?identity/i)
    expect(errorOf(await rpc.request('broker.health', {})).message).toMatch(
      /bootstrap|install.?identity/i
    )

    // 2. Install, replay, and the epoch fence.
    const ack = resultOf(await rpc.request('broker.installIdentity', IDENTITY))
    expect(ack).toMatchObject({ installed: true, invocationId: IDENTITY.invocationId })
    expect(resultOf(await rpc.request('broker.installIdentity', { ...IDENTITY }))).toEqual(ack)
    expect(
      errorOf(await rpc.request('broker.installIdentity', { ...IDENTITY, attachEpoch: 2 })).message
    ).toMatch(/epoch|identity|conflict/i)

    // 3. The ordinary surface is live once identity exists.
    const hello = resultOf(
      await rpc.request('broker.hello', {
        clientInfo: { name: 't08346-packaged' },
        protocolVersions: ['harness-broker/0.3'],
      })
    ) as { capabilities: { transports: string[]; attachReplay?: boolean } }
    expect(hello.capabilities.transports).toContain('unix-jsonrpc-ndjson')
    expect(hello.capabilities.attachReplay).toBe(true)

    // 4. Install does NOT make the participant resident: attach still refuses.
    expect(
      errorOf(
        await rpc.request('broker.attach', {
          ...IDENTITY,
          controllerInstanceId: 'packaged-controller',
        })
      ).message
    ).toMatch(/unknown invocation/i)

    // 5. A definitive start failure is recorded once and replayed, not retried.
    //    `not-a-registered-driver` is refused by the ORDINARY driver registry,
    //    which is what keeps this smoke hermetic: no agent binary, no
    //    credentials, and still the real start path.
    const ensure = {
      startAttemptId: 'attempt_packaged',
      invocationId: IDENTITY.invocationId,
      attachEpoch: IDENTITY.attachEpoch,
      startRequest: {
        spec: {
          specVersion: 'harness-broker.invocation/v1',
          invocationId: IDENTITY.invocationId,
          labels: { acceptance: 'T-08346' },
          harness: {
            frontend: 'test',
            provider: 'test',
            driver: 'not-a-registered-driver',
          },
          process: {
            command: 'not-a-registered-driver',
            args: [],
            cwd: repoRoot,
            harnessTransport: { kind: 'pipes' },
          },
          interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
          driver: { kind: 'not-a-registered-driver' },
          correlation: {
            runtimeId: IDENTITY.runtimeId,
            hostSessionId: IDENTITY.hostSessionId,
            startRequestHash: IDENTITY.startRequestHash,
            selectedProfileHash: IDENTITY.selectedProfileHash,
          },
        },
      },
    }
    const failed = resultOf(await rpc.request('broker.ensureInvocation', ensure)) as {
      receipt: { state: string; failure?: { message: string } }
    }
    expect(failed.receipt.state).toBe('failed')
    expect(failed.receipt.failure?.message).toMatch(/No driver registered/)
    const replayed = resultOf(await rpc.request('broker.ensureInvocation', ensure))
    expect(replayed).toEqual(failed as unknown as Record<string, unknown>)

    // 6. Same attempt, different immutable request => refused.
    expect(
      errorOf(
        await rpc.request('broker.ensureInvocation', {
          ...ensure,
          startRequest: {
            spec: { ...ensure.startRequest.spec, labels: { acceptance: 'T-08346', drift: 'yes' } },
          },
        })
      ).message
    ).toMatch(/conflict|immutable|digest/i)

    // 7. The receipt journal is on disk beside the ledger it explains.
    const journal = await readFile(join(ledgerDir, 'ensure-receipts.ndjson'), 'utf8')
    const states = journal
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => (JSON.parse(line) as { state: string }).state)
    expect(states).toEqual(['prepared', 'starting', 'failed'])
  }, 30_000)

  test('an unbound packaged unix broker keeps serving without any identity', async () => {
    // Regression guard for the existing supported non-participant route: no
    // `--join`, no identity flags, full surface. Bootstrap posture must be a
    // declared startup posture, never an inference from a missing flag.
    const dir = join('/tmp', `t83pkg-${crypto.randomUUID().slice(0, 8)}`)
    await mkdir(dir, { recursive: true })
    const socketPath = join(dir, 'broker.sock')
    await writeFile(join(dir, '.keep'), '')
    const process_ = Bun.spawn({
      cmd: ['bun', brokerBin, 'run', '--transport', 'unix', '--socket', socketPath],
      cwd: repoRoot,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: brokerProcessEnv({ HARNESS_BROKER_USE_DIST: '1' }),
    })
    spawned.push({ dir, process: process_ })

    const deadline = Date.now() + 5_000
    let bound = false
    while (Date.now() < deadline && !bound) {
      try {
        bound = (await stat(socketPath)).isSocket()
      } catch {
        bound = false
      }
      if (!bound) await Bun.sleep(25)
    }
    expect(bound).toBe(true)

    const rpc = await Rpc.connect(socketPath)
    const hello = resultOf(
      await rpc.request('broker.hello', {
        clientInfo: { name: 't08346-packaged-legacy' },
        protocolVersions: ['harness-broker/0.3'],
      })
    ) as { protocolVersion: string }
    expect(hello.protocolVersion).toBe('harness-broker/0.3')
    expect(resultOf(await rpc.request('broker.health', {}))).toMatchObject({ status: 'ok' })
  }, 30_000)
})
