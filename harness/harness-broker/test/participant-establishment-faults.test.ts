import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  BrokerEnsureInvocationReceipt,
  BrokerEnsureInvocationRequest,
  HarnessInvocationSpec,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import { ENSURE_RECEIPT_JOURNAL_FILENAME } from '../src/ensure-receipt-store'
import { createTestDriver } from '../src/testing/test-driver'

/**
 * T-08346 — the ONE window the acceptance suite cannot reach from outside.
 *
 * `broker.ensureInvocation` persists `prepared` (no driver side effect
 * initiated) and then `starting` (persisted BEFORE `driver.start`). A crash
 * BETWEEN those two writes is externally indistinguishable from a crash before
 * either, so the acceptance suite over real IPC can only observe the `starting`
 * case. This suite drives the same broker in-process with a narrow injected
 * fault in exactly that window.
 *
 * The seam is `BrokerOptions.participantFaults`, reachable only by constructing
 * a broker in-process. It is NOT a product feature flag: no CLI flag and no
 * environment variable reaches it, so a packaged broker has no way to be put
 * into this state by a caller.
 */

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 't08346-faults-'))
  dirs.push(dir)
  return dir
}

const IDENTITY = {
  runtimeId: 'runtime_t08346_fault',
  hostSessionId: 'host_session_t08346_fault',
  generation: 3,
  attachEpoch: 1,
  invocationId: 'inv_t08346_fault',
  startRequestHash: 'start_hash_t08346_fault',
  selectedProfileHash: 'profile_hash_t08346_fault',
  attachToken: 'attach_token_t08346_fault',
} as const

const spec = (): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: IDENTITY.invocationId,
  labels: { acceptance: 'T-08346' },
  harness: { frontend: 'test', provider: 'test', driver: 't08346-fault-driver' },
  process: {
    command: 't08346-fault-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'none' },
  driver: { kind: 't08346-fault-driver' },
  correlation: {
    runtimeId: IDENTITY.runtimeId,
    hostSessionId: IDENTITY.hostSessionId,
    startRequestHash: IDENTITY.startRequestHash,
    selectedProfileHash: IDENTITY.selectedProfileHash,
  },
})

const ensureRequest = (startAttemptId: string): BrokerEnsureInvocationRequest =>
  ({
    startAttemptId,
    invocationId: IDENTITY.invocationId,
    attachEpoch: IDENTITY.attachEpoch,
    startRequest: { spec: spec() },
  }) as unknown as BrokerEnsureInvocationRequest

/**
 * A broker over `receiptDir`, with a controlled driver that counts its own
 * `driver.start` calls. Building a SECOND one over the same directory is how a
 * restart is modelled: nothing in-memory survives, only the journal does.
 */
function brokerOver(
  receiptDir: string,
  starts: { count: number },
  beforeStartingPersist?: () => void
) {
  return createBroker({
    drivers: [
      createTestDriver({
        kind: 't08346-fault-driver',
        onStart() {
          starts.count += 1
        },
      }).driver,
    ],
    receiptDir,
    participantBootstrap: true,
    ...(beforeStartingPersist !== undefined
      ? { participantFaults: { beforeStartingPersist } }
      : {}),
  })
}

async function journalStates(dir: string, startAttemptId: string): Promise<string[]> {
  const contents = await readFile(join(dir, ENSURE_RECEIPT_JOURNAL_FILENAME), 'utf8')
  return contents
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as BrokerEnsureInvocationReceipt)
    .filter((receipt) => receipt.startAttemptId === startAttemptId)
    .map((receipt) => receipt.state)
}

describe('T-08346 prepared-before-starting crash window', () => {
  test('a crash after prepared and before starting leaves the attempt startable exactly once', async () => {
    const dir = scratchDir()
    const starts = { count: 0 }
    const attempt = 'attempt_prepared_crash'

    const crashed = brokerOver(dir, starts, () => {
      throw new Error('t08346 injected crash between prepared and starting')
    })
    await crashed.installIdentity(IDENTITY)
    await expect(crashed.ensureInvocation(ensureRequest(attempt))).rejects.toThrow(/injected crash/)

    // The whole point of `prepared`: no driver side effect was initiated, and
    // the journal says so, so the retry is allowed to start.
    expect(starts.count).toBe(0)
    expect(await journalStates(dir, attempt)).toEqual(['prepared'])

    const restarted = brokerOver(dir, starts)
    await restarted.installIdentity(IDENTITY)
    const receipt = (await restarted.ensureInvocation(ensureRequest(attempt))).receipt
    expect(receipt.state).toBe('started')
    expect(starts.count).toBe(1)
    expect(await journalStates(dir, attempt)).toEqual([
      'prepared',
      'prepared',
      'starting',
      'started',
    ])

    // And the retry is still idempotent afterwards.
    const replay = (await restarted.ensureInvocation(ensureRequest(attempt))).receipt
    expect(replay).toEqual(receipt)
    expect(starts.count).toBe(1)
  })

  test('the starting receipt is durable BEFORE driver.start runs', async () => {
    const dir = scratchDir()
    const attempt = 'attempt_starting_ordering'
    const observed: string[][] = []
    const broker = createBroker({
      drivers: [
        createTestDriver({
          kind: 't08346-fault-driver',
          async onStart() {
            // Read the journal from INSIDE driver.start: whatever is on disk
            // here is what a `kill -9` at this instant would leave behind.
            observed.push(await journalStates(dir, attempt))
          },
        }).driver,
      ],
      receiptDir: dir,
      participantBootstrap: true,
    })
    await broker.installIdentity(IDENTITY)
    await broker.ensureInvocation(ensureRequest(attempt))
    expect(observed).toEqual([['prepared', 'starting']])
  })

  test('bootstrap posture refuses the whole surface until identity is installed', async () => {
    const dir = scratchDir()
    const starts = { count: 0 }
    const broker = brokerOver(dir, starts)

    await expect(
      broker.hello({ clientInfo: { name: 't08346' }, protocolVersions: ['harness-broker/0.3'] })
    ).rejects.toMatchObject({ code: BrokerErrorCode.BrokerBootstrapRequired })
    await expect(broker.health({})).rejects.toMatchObject({
      code: BrokerErrorCode.BrokerBootstrapRequired,
    })
    await expect(broker.ensureInvocation(ensureRequest('attempt_gated'))).rejects.toMatchObject({
      code: BrokerErrorCode.BrokerBootstrapRequired,
    })

    await broker.installIdentity(IDENTITY)
    const hello = await broker.hello({
      clientInfo: { name: 't08346' },
      protocolVersions: ['harness-broker/0.3'],
    })
    expect(hello.protocolVersion).toBe('harness-broker/0.3')
    expect(starts.count).toBe(0)
  })

  test('a broker NOT in participant posture keeps its existing unbound surface', async () => {
    // The existing supported non-participant unix route: no identity flags and
    // no participant declaration. It must not be dragged into bootstrap.
    const broker = createBroker({ drivers: [] })
    const hello = await broker.hello({
      clientInfo: { name: 't08346' },
      protocolVersions: ['harness-broker/0.3'],
    })
    expect(hello.protocolVersion).toBe('harness-broker/0.3')
    expect((await broker.health({})).status).toBe('ok')
  })
})
