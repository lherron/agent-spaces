import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { type Socket, connect } from 'node:net'
import { join } from 'node:path'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'
import { brokerProcessEnv } from './helpers'

/**
 * T-08346 acceptance RED (DESIGN rev6 C.5.1).
 *
 * These tests deliberately speak raw JSON-RPC over the broker's real Unix
 * socket. The new protocol/client exports do not exist at the red commit, and
 * defining local replacement DTOs would let this suite agree with a second,
 * invented protocol. The payloads below use only fields named by C.5.1 plus
 * the existing InvocationDispatchRequest and attach identity fields.
 *
 * Receipt-crash tests reuse the real --event-ledger directory. They never
 * inspect or seed private receipt storage: a restart is accepted only by what
 * the public ensure RPC reports and by the controlled driver's on-disk effect
 * count. This keeps the durable ledger seam load-bearing across refactors.
 */

type RpcId = string | number
type RpcFrame =
  | { jsonrpc: '2.0'; id: RpcId; result: unknown }
  | {
      jsonrpc: '2.0'
      id: RpcId | null
      error: { code: number; message: string; data?: unknown }
    }
  | { jsonrpc: '2.0'; method: string; params?: unknown }

interface RuntimeIdentity {
  runtimeId: string
  hostSessionId: string
  generation: number
  attachEpoch: number
  invocationId: string
  startRequestHash: string
  selectedProfileHash: string
  attachToken: string
}

interface BrokerProcess {
  dir: string
  socketPath: string
  ledgerPath: string
  tokenPath: string
  effectsPath: string
  process: ReturnType<typeof Bun.spawn>
  hosted: boolean
  delayMs: number
}

const repoRoot = new URL('../../..', import.meta.url).pathname
const fixturePath = join(
  repoRoot,
  'harness/harness-broker/test/fixtures/t08346-participant-broker.ts'
)
const brokers: BrokerProcess[] = []
const sockets = new Set<RpcConnection>()

const identity = (suffix: string, attachEpoch = 1): RuntimeIdentity => ({
  runtimeId: `runtime_t08346_${suffix}`,
  hostSessionId: `host_session_t08346_${suffix}`,
  generation: 7,
  attachEpoch,
  invocationId: `inv_t08346_${suffix}`,
  startRequestHash: `start_hash_t08346_${suffix}`,
  selectedProfileHash: `profile_hash_t08346_${suffix}`,
  attachToken: `attach_token_t08346_${suffix}`,
})

const spec = (who: RuntimeIdentity, label = 'original'): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: who.invocationId,
  labels: { acceptance: 'T-08346', label },
  harness: {
    frontend: 'test',
    provider: 'test',
    driver: 't08346-controlled-driver',
  },
  process: {
    command: 't08346-controlled-driver',
    args: [],
    cwd: repoRoot,
    harnessTransport: { kind: 'pipes' },
  },
  interaction: {
    mode: 'headless',
    turnConcurrency: 'single',
    inputQueue: 'none',
  },
  driver: { kind: 't08346-controlled-driver' },
  correlation: {
    runtimeId: who.runtimeId,
    hostSessionId: who.hostSessionId,
    startRequestHash: who.startRequestHash,
    selectedProfileHash: who.selectedProfileHash,
  },
})

const installParams = (who: RuntimeIdentity) => ({ ...who })

const ensureParams = (
  startAttemptId: string,
  who: RuntimeIdentity,
  options: {
    label?: string
    dispatchEnv?: Record<string, string>
  } = {}
) => ({
  startAttemptId,
  invocationId: who.invocationId,
  attachEpoch: who.attachEpoch,
  startRequest: { spec: spec(who, options.label) },
  ...(options.dispatchEnv !== undefined ? { dispatchEnv: options.dispatchEnv } : {}),
})

const attachParams = (who: RuntimeIdentity, controllerInstanceId: string) => ({
  ...who,
  controllerInstanceId,
  clientCapabilities: { eventReplay: true },
})

const helloParams = {
  clientInfo: { name: 't08346-acceptance', version: '1' },
  protocolVersions: ['harness-broker/0.3', 'harness-broker/0.2'],
  capabilities: { eventReplay: true },
}

class RpcConnection {
  readonly #socket: Socket
  readonly #pending = new Map<RpcId, (frame: RpcFrame) => void>()
  #buffer = ''
  #nextId = 1

  private constructor(socket: Socket) {
    this.#socket = socket
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => this.#onData(chunk))
    socket.on('close', () => {
      for (const [id, resolve] of this.#pending) {
        resolve({
          jsonrpc: '2.0',
          id,
          error: { code: -32000, message: 'socket closed before response' },
        })
      }
      this.#pending.clear()
    })
  }

  static connect(socketPath: string): Promise<RpcConnection> {
    return new Promise((resolve, reject) => {
      const socket = connect({ path: socketPath })
      socket.once('error', reject)
      socket.once('connect', () => {
        socket.removeListener('error', reject)
        const rpc = new RpcConnection(socket)
        sockets.add(rpc)
        resolve(rpc)
      })
    })
  }

  request(method: string, params: unknown): Promise<RpcFrame> {
    const id = `t08346-${this.#nextId++}`
    return new Promise((resolve) => {
      this.#pending.set(id, resolve)
      this.#socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  sendAndForget(method: string, params: unknown): void {
    const id = `t08346-lost-${this.#nextId++}`
    this.#socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  }

  destroy(): void {
    sockets.delete(this)
    this.#socket.destroy()
  }

  #onData(chunk: string): void {
    this.#buffer += chunk
    while (true) {
      const newline = this.#buffer.indexOf('\n')
      if (newline < 0) return
      const line = this.#buffer.slice(0, newline)
      this.#buffer = this.#buffer.slice(newline + 1)
      if (line.length === 0) continue
      const frame = JSON.parse(line) as RpcFrame
      if (!('id' in frame) || frame.id === null) continue
      const resolve = this.#pending.get(frame.id)
      if (resolve === undefined) continue
      this.#pending.delete(frame.id)
      resolve(frame)
    }
  }
}

async function startBroker(options: {
  suffix: string
  hosted?: boolean
  delayMs?: number
  reuse?: BrokerProcess
}): Promise<BrokerProcess> {
  const who = identity(options.suffix)
  // macOS sockaddr_un is 104 bytes. /tmp resolves to a short stable prefix;
  // the default tmpdir under /var/folders makes even this tiny socket exceed it.
  const dir = options.reuse?.dir ?? join('/tmp', `t83-${crypto.randomUUID().slice(0, 8)}`)
  const socketPath = options.reuse?.socketPath ?? join(dir, 'broker.sock')
  const ledgerPath = options.reuse?.ledgerPath ?? join(dir, 'events.ndjson')
  const tokenPath = options.reuse?.tokenPath ?? join(dir, 'attach.token')
  const effectsPath = options.reuse?.effectsPath ?? join(dir, 'driver-start-effects.txt')
  const hosted = options.hosted ?? options.reuse?.hosted ?? false
  const delayMs = options.delayMs ?? options.reuse?.delayMs ?? 0

  await mkdir(dir, { recursive: true })
  await writeFile(tokenPath, who.attachToken)
  const args = [
    fixturePath,
    'run',
    '--transport',
    'unix',
    '--socket',
    socketPath,
    '--event-ledger',
    ledgerPath,
  ]
  if (hosted) {
    args.push(
      '--runtime-id',
      who.runtimeId,
      '--host-session-id',
      who.hostSessionId,
      '--generation',
      String(who.generation),
      '--attach-token-file',
      tokenPath
    )
  }

  const process = Bun.spawn({
    cmd: ['bun', ...args],
    cwd: repoRoot,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: brokerProcessEnv({
      T08346_DRIVER_START_EFFECTS: effectsPath,
      T08346_DRIVER_START_DELAY_MS: String(delayMs),
    }),
  })
  const broker = {
    dir,
    socketPath,
    ledgerPath,
    tokenPath,
    effectsPath,
    process,
    hosted,
    delayMs,
  }
  brokers.push(broker)
  await waitForSocket(broker)
  return broker
}

async function waitForSocket(broker: BrokerProcess): Promise<void> {
  await waitUntil(async () => {
    if (broker.process.exitCode !== null) {
      const stderr = await new Response(broker.process.stderr).text()
      throw new Error(`broker exited before socket bind: ${stderr.trim()}`)
    }
    try {
      return (await stat(broker.socketPath)).isSocket()
    } catch {
      return false
    }
  }, 'broker Unix socket was not created')
}

async function waitUntil(check: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(20)
  }
  throw new Error(message)
}

async function stopBroker(broker: BrokerProcess, signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
  const index = brokers.indexOf(broker)
  if (index >= 0) brokers.splice(index, 1)
  if (broker.process.exitCode === null) broker.process.kill(signal)
  await broker.process.exited.catch(() => {})
}

async function effectCount(path: string): Promise<number> {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).length
  } catch {
    return 0
  }
}

function expectResult(frame: RpcFrame): unknown {
  expect(frame).not.toHaveProperty('error')
  expect(frame).toHaveProperty('result')
  return 'result' in frame ? frame.result : undefined
}

function expectError(frame: RpcFrame, message: RegExp): void {
  expect(frame).toHaveProperty('error')
  if ('error' in frame) expect(frame.error.message).toMatch(message)
}

function expectMethodRegistered(frame: RpcFrame): void {
  expect(frame).toHaveProperty('error')
  if ('error' in frame) expect(frame.error.code).not.toBe(-32601)
}

function expectReceipt(
  frame: RpcFrame,
  expected: { startAttemptId: string; invocationId: string; state: string }
): unknown {
  const result = expectResult(frame) as Record<string, unknown>
  const receipt = (result?.['receipt'] ?? result) as Record<string, unknown>
  expect(receipt).toMatchObject(expected)
  return receipt
}

async function install(rpc: RpcConnection, who: RuntimeIdentity): Promise<unknown> {
  return expectResult(await rpc.request('broker.installIdentity', installParams(who)))
}

async function stopAndDispose(rpc: RpcConnection, invocationId: string): Promise<void> {
  expectResult(
    await rpc.request('invocation.stop', {
      invocationId,
      reason: 'T-08346 acceptance boundary',
      graceMs: 10,
    })
  )
  expectResult(await rpc.request('invocation.dispose', { invocationId }))
}

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  const remaining = brokers.splice(0)
  await Promise.all(
    remaining.map(async (broker) => {
      if (broker.process.exitCode === null) broker.process.kill('SIGTERM')
      await broker.process.exited.catch(() => {})
    })
  )
  await Promise.all(
    [...new Set(remaining.map((broker) => broker.dir))].map((dir) =>
      rm(dir, { recursive: true, force: true })
    )
  )
})

describe('T-08346 participant bootstrap and resident invocation acceptance', () => {
  test('participant bootstrap exposes only installIdentity and fences install retries by epoch', async () => {
    const broker = await startBroker({ suffix: 'participant_bootstrap' })
    const who = identity('participant_bootstrap')
    const rpc = await RpcConnection.connect(broker.socketPath)

    expectError(await rpc.request('broker.hello', helloParams), /bootstrap|install.?identity/i)
    expectError(await rpc.request('broker.health', {}), /bootstrap|install.?identity/i)
    expectError(
      await rpc.request('broker.attach', attachParams(who, 'controller-before-install')),
      /bootstrap|install.?identity/i
    )

    const firstAck = await install(rpc, who)
    const replayAck = await install(rpc, structuredClone(who))
    expect(replayAck).toEqual(firstAck)

    expectError(
      await rpc.request('broker.installIdentity', installParams({ ...who, attachEpoch: 2 })),
      /epoch|identity|conflict/i
    )

    // Negative scope guard: epoch conflict is broker-incarnation scoped, not
    // an unbounded historical suppression. A new participant process accepts
    // a new epoch rather than inheriting the prior process's install fence.
    const nextBroker = await startBroker({ suffix: 'participant_next_process' })
    const nextRpc = await RpcConnection.connect(nextBroker.socketPath)
    await expect(
      Promise.resolve(install(nextRpc, identity('participant_next_process', 2)))
    ).resolves.toBeDefined()
  })

  test('install and hello do not make a participant resident; ensure does', async () => {
    const broker = await startBroker({ suffix: 'participant_fresh' })
    const who = identity('participant_fresh')
    const rpc = await RpcConnection.connect(broker.socketPath)

    await install(rpc, who)
    expectResult(await rpc.request('broker.hello', helloParams))
    expectError(
      await rpc.request('broker.attach', attachParams(who, 'controller-before-resident')),
      /unknown invocation/i
    )

    const attempt = 'attempt_participant_fresh'
    expectReceipt(await rpc.request('broker.ensureInvocation', ensureParams(attempt, who)), {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    expect(await effectCount(broker.effectsPath)).toBe(1)
    expectResult(await rpc.request('broker.attach', attachParams(who, 'controller-after-resident')))
  })

  test('the hosted route also establishes the resident through ensure before attach', async () => {
    const broker = await startBroker({ suffix: 'hosted_fresh', hosted: true })
    const who = identity('hosted_fresh')
    const rpc = await RpcConnection.connect(broker.socketPath)

    expectResult(await rpc.request('broker.hello', helloParams))
    expectError(
      await rpc.request('broker.attach', attachParams(who, 'hosted-before-resident')),
      /unknown invocation/i
    )

    const attempt = 'attempt_hosted_fresh'
    expectReceipt(await rpc.request('broker.ensureInvocation', ensureParams(attempt, who)), {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    expect(await effectCount(broker.effectsPath)).toBe(1)
    expectResult(await rpc.request('broker.attach', attachParams(who, 'hosted-after-resident')))
  })

  test('concurrent matching ensures serialize to one driver start and one receipt', async () => {
    const broker = await startBroker({ suffix: 'concurrent', hosted: true, delayMs: 100 })
    const who = identity('concurrent')
    const first = await RpcConnection.connect(broker.socketPath)
    const second = await RpcConnection.connect(broker.socketPath)
    const attempt = 'attempt_concurrent'

    const [left, right] = await Promise.all([
      first.request('broker.ensureInvocation', ensureParams(attempt, who)),
      second.request('broker.ensureInvocation', ensureParams(attempt, who)),
    ])
    const leftReceipt = expectReceipt(left, {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    const rightReceipt = expectReceipt(right, {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    expect(rightReceipt).toEqual(leftReceipt)
    expect(await effectCount(broker.effectsPath)).toBe(1)
  })

  test('a lost ensure response retries the durable receipt without repeating driver.start', async () => {
    const broker = await startBroker({ suffix: 'lost_response', hosted: true, delayMs: 80 })
    const who = identity('lost_response')
    const canary = await RpcConnection.connect(broker.socketPath)

    // Fail as a collected assertion on the absent RPC before entering the
    // deliberate response-loss path; current-red evidence must never be a
    // timeout caused merely by sending an unknown method.
    expectMethodRegistered(await canary.request('broker.ensureInvocation', {}))
    canary.destroy()

    const lost = await RpcConnection.connect(broker.socketPath)
    const attempt = 'attempt_lost_response'
    lost.sendAndForget('broker.ensureInvocation', ensureParams(attempt, who))
    await Bun.sleep(25)
    lost.destroy()

    await waitUntil(
      async () => (await effectCount(broker.effectsPath)) === 1,
      'controlled driver did not observe the first ensure effect'
    )
    await Bun.sleep(120)

    const retry = await RpcConnection.connect(broker.socketPath)
    expectReceipt(await retry.request('broker.ensureInvocation', ensureParams(attempt, who)), {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    expect(await effectCount(broker.effectsPath)).toBe(1)
  })

  test('same-attempt request/options conflicts refuse while a distinct attempt remains independent', async () => {
    const broker = await startBroker({ suffix: 'conflict', hosted: true })
    const firstIdentity = identity('conflict')
    const rpc = await RpcConnection.connect(broker.socketPath)
    const firstAttempt = 'attempt_conflict'

    expectReceipt(
      await rpc.request('broker.ensureInvocation', ensureParams(firstAttempt, firstIdentity)),
      {
        startAttemptId: firstAttempt,
        invocationId: firstIdentity.invocationId,
        state: 'started',
      }
    )
    expectError(
      await rpc.request(
        'broker.ensureInvocation',
        ensureParams(firstAttempt, firstIdentity, { label: 'changed-request' })
      ),
      /conflict|immutable|digest/i
    )
    expectError(
      await rpc.request(
        'broker.ensureInvocation',
        ensureParams(firstAttempt, firstIdentity, { dispatchEnv: { T08346_VALUE: 'changed' } })
      ),
      /conflict|immutable|digest/i
    )
    expect(await effectCount(broker.effectsPath)).toBe(1)

    await stopAndDispose(rpc, firstIdentity.invocationId)
    const secondIdentity = {
      ...firstIdentity,
      invocationId: 'inv_t08346_conflict_independent',
      startRequestHash: 'start_hash_t08346_conflict_independent',
      selectedProfileHash: 'profile_hash_t08346_conflict_independent',
    }
    const secondAttempt = 'attempt_conflict_independent'
    expectReceipt(
      await rpc.request(
        'broker.ensureInvocation',
        ensureParams(secondAttempt, secondIdentity, {
          label: 'changed-request',
          dispatchEnv: { T08346_VALUE: 'changed' },
        })
      ),
      {
        startAttemptId: secondAttempt,
        invocationId: secondIdentity.invocationId,
        state: 'started',
      }
    )
    expect(await effectCount(broker.effectsPath)).toBe(2)
  })

  test('restart after starting was persisted reports indeterminate and never starts again', async () => {
    const broker = await startBroker({ suffix: 'crash_starting', hosted: true, delayMs: 30_000 })
    const who = identity('crash_starting')
    const rpc = await RpcConnection.connect(broker.socketPath)

    expectMethodRegistered(await rpc.request('broker.ensureInvocation', {}))
    rpc.sendAndForget('broker.ensureInvocation', ensureParams('attempt_crash_starting', who))
    await waitUntil(
      async () => (await effectCount(broker.effectsPath)) === 1,
      'controlled driver did not reach its start effect before crash'
    )
    await stopBroker(broker, 'SIGKILL')

    const restarted = await startBroker({
      suffix: 'crash_starting',
      hosted: true,
      delayMs: 0,
      reuse: broker,
    })
    const retry = await RpcConnection.connect(restarted.socketPath)
    expectReceipt(
      await retry.request('broker.ensureInvocation', ensureParams('attempt_crash_starting', who)),
      {
        startAttemptId: 'attempt_crash_starting',
        invocationId: who.invocationId,
        state: 'indeterminate',
      }
    )
    expect(await effectCount(restarted.effectsPath)).toBe(1)
  })

  test('a started receipt without its resident manager invocation becomes indeterminate', async () => {
    const broker = await startBroker({ suffix: 'missing_resident', hosted: true })
    const who = identity('missing_resident')
    const rpc = await RpcConnection.connect(broker.socketPath)
    const attempt = 'attempt_missing_resident'

    expectReceipt(await rpc.request('broker.ensureInvocation', ensureParams(attempt, who)), {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'started',
    })
    expect(await effectCount(broker.effectsPath)).toBe(1)
    await stopBroker(broker)

    const restarted = await startBroker({
      suffix: 'missing_resident',
      hosted: true,
      reuse: broker,
    })
    const retry = await RpcConnection.connect(restarted.socketPath)
    expectReceipt(await retry.request('broker.ensureInvocation', ensureParams(attempt, who)), {
      startAttemptId: attempt,
      invocationId: who.invocationId,
      state: 'indeterminate',
    })
    expect(await effectCount(restarted.effectsPath)).toBe(1)
  })

  test('legacy hosted invocation.start and attach remain compatible', async () => {
    const broker = await startBroker({ suffix: 'legacy_hosted', hosted: true })
    const who = identity('legacy_hosted')
    const rpc = await RpcConnection.connect(broker.socketPath)

    expectResult(await rpc.request('broker.hello', helloParams))
    expectResult(
      await rpc.request('invocation.start', {
        startRequest: { spec: spec(who) },
      })
    )
    expect(await effectCount(broker.effectsPath)).toBe(1)
    expectResult(await rpc.request('broker.attach', attachParams(who, 'legacy-controller')))
  })
})
