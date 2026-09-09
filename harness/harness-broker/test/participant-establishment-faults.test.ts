import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
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
import {
  ENSURE_RECEIPT_JOURNAL_FILENAME,
  createEnsureReceiptStore,
} from '../src/ensure-receipt-store'
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

describe('T-08346 durable receipt journal maintenance', () => {
  // Astra grade, defect 1: dropping a torn trailing record in MEMORY only left
  // the fragment on disk, so the next append concatenated onto it and produced
  // a complete-looking line that no later open could parse — bricking the
  // restart path the receipt exists to serve. Reproduced before the fix as:
  //   put(prepared); append '{"startAttemptId":' with no newline;
  //   reopen => prepared; put(starting); reopen => SyntaxError.
  const receiptFor = (startAttemptId: string, state: string) =>
    ({
      startAttemptId,
      invocationId: 'inv_journal',
      attachEpoch: 1,
      state,
      requestDigest: 'digest_journal',
      brokerInstanceId: 'broker_journal',
      updatedAt: '2026-09-09T00:00:00.000Z',
    }) as unknown as BrokerEnsureInvocationReceipt

  test('a torn trailing record is repaired at owner-open, so reopen -> append -> reopen survives', () => {
    const dir = scratchDir()
    const journal = join(dir, ENSURE_RECEIPT_JOURNAL_FILENAME)
    const warnings: string[] = []

    createEnsureReceiptStore({ dir, logWarn: (line) => warnings.push(line) }).put(
      receiptFor('attempt_journal', 'prepared')
    )
    // A crash mid-append: bytes on disk, no newline, fsync never returned.
    appendFileSync(journal, '{"startAttemptId":')

    const reopened = createEnsureReceiptStore({ dir, logWarn: (line) => warnings.push(line) })
    expect(reopened.get('attempt_journal')?.state).toBe('prepared')
    expect(reopened.tailRepair()).toMatchObject({ truncatedBytes: 18 })
    expect(warnings.at(-1)).toMatch(/tail repaired/)

    // The append that used to corrupt the journal.
    reopened.put(receiptFor('attempt_journal', 'starting'))

    const final = createEnsureReceiptStore({ dir, logWarn: (line) => warnings.push(line) })
    expect(final.get('attempt_journal')?.state).toBe('starting')
    // Repaired once; the second open finds an intact tail and repairs nothing.
    expect(final.tailRepair()).toBeUndefined()
    expect(final.list().map((entry) => entry.state)).toEqual(['starting'])
  })

  test('interior corruption is reported, not silently dropped', () => {
    const dir = scratchDir()
    // A COMPLETE, newline-terminated record that will not parse is damage
    // behind our back: dropping it could resurrect a superseded state.
    writeFileSync(
      join(dir, ENSURE_RECEIPT_JOURNAL_FILENAME),
      `${JSON.stringify(receiptFor('a', 'prepared'))}\nnot-json\n${JSON.stringify(receiptFor('a', 'started'))}\n`
    )
    expect(() => createEnsureReceiptStore({ dir, logWarn: () => {} })).toThrow(
      /Corrupt ensure-receipt journal/
    )
  })
})

describe('T-08346 start-failure classification', () => {
  // Astra grade, defect 2: every rejection from the start was written as
  // `failed`, but `manager.start` rethrows a `driver.start` throw AFTER the
  // driver ran. A rejected promise therefore cannot mean "no native effect".
  test('a driver that produces an effect and then throws is indeterminate, never failed', async () => {
    const dir = scratchDir()
    const attempt = 'attempt_effect_then_throw'
    let starts = 0
    const broker = createBroker({
      drivers: [
        createTestDriver({
          kind: 't08346-fault-driver',
          onStart() {
            starts += 1
            throw new Error('native effect produced, then failed')
          },
        }).driver,
      ],
      receiptDir: dir,
      participantBootstrap: true,
    })
    await broker.installIdentity(IDENTITY)

    const receipt = (await broker.ensureInvocation(ensureRequest(attempt))).receipt
    expect(starts).toBe(1)
    expect(receipt.state).toBe('indeterminate')
    expect(receipt.indeterminateReason).toBe('start_outcome_unclassified')
    // Diagnostic only: it says what was seen, not that nothing happened.
    expect(receipt.failure?.message).toMatch(/native effect produced/)

    // Absorbing: the retry reports the same unknown and never starts again.
    const retried = (await broker.ensureInvocation(ensureRequest(attempt))).receipt
    expect(retried).toEqual(receipt)
    expect(starts).toBe(1)
    expect(await journalStates(dir, attempt)).toEqual(['prepared', 'starting', 'indeterminate'])
  })

  test('a refusal proven to precede driver entry is definitively failed', async () => {
    const dir = scratchDir()
    const attempt = 'attempt_no_driver'
    let starts = 0
    // Positive control for `failed`: driver resolution refuses before the
    // manager is entered, so no driver could have produced anything.
    const broker = createBroker({
      drivers: [
        createTestDriver({
          kind: 'a-different-driver',
          onStart() {
            starts += 1
          },
        }).driver,
      ],
      receiptDir: dir,
      participantBootstrap: true,
    })
    await broker.installIdentity(IDENTITY)

    const receipt = (await broker.ensureInvocation(ensureRequest(attempt))).receipt
    expect(receipt.state).toBe('failed')
    expect(receipt.failure?.message).toMatch(/No driver registered/)
    expect(starts).toBe(0)
    expect(await journalStates(dir, attempt)).toEqual(['prepared', 'starting', 'failed'])
  })
})
