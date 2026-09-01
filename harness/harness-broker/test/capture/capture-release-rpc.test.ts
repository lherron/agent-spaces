import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationCaptureReleaseResponse,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import { CAPTURE_RELEASE_NOT_BLOCKED, validateCommand } from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createEventLedger } from '../../src/event-ledger'
import { createTestDriver } from '../../src/testing/test-driver'

const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId,
  harness: { frontend: 'test', provider: 'test', driver: 'test-driver' },
  process: {
    command: 'test-driver',
    args: [],
    cwd: process.cwd(),
    harnessTransport: { kind: 'pipes' },
  },
  interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
  driver: { kind: 'test-driver' },
})

function durableBroker(invocationId: string) {
  const dir = mkdtempSync(join(tmpdir(), 'capture-rpc-'))
  roots.push(dir)
  const events: InvocationEventEnvelope[] = []
  const { driver, controller } = createTestDriver()
  const broker = createBroker({
    drivers: [driver],
    eventLedger: createEventLedger({ path: join(dir, 'events.ndjson') }),
    captureDir: dir,
    onEvent: (event) => events.push(event),
  })
  return { broker, controller, events, dir, invocationId }
}

describe('invocation.capture.release (fenced control RPC)', () => {
  test('a halted cursor is visible in snapshot and resumed by an operator release', async () => {
    const h = durableBroker('inv_release_1')
    await h.broker.start({ spec: spec(h.invocationId) })

    h.controller.captureRow('known.row', { n: 1 }, { disposition: 'normalized' })
    h.controller.captureRow(
      'queue-operation:reprioritize',
      { operation: 'reprioritize' },
      {
        disposition: 'blocked-unknown',
        family: 'submission-disposition',
        message: 'Unknown test queue operation: reprioritize',
      }
    )
    h.controller.captureRow('held.row', { n: 2 }, { disposition: 'normalized' })

    // §5: the halt must be visible in `snapshot`, and the seat keeps running.
    const blockedSnapshot = await h.broker.snapshot({ invocationId: h.invocationId })
    expect(blockedSnapshot.capture).toMatchObject({
      state: 'blocked',
      deferredCount: 1,
      blockedOn: {
        nativeType: 'queue-operation:reprioritize',
        family: 'submission-disposition',
      },
    })
    expect(blockedSnapshot.state).toBe('ready')

    const warning = h.events.find((e) => e.type === 'capture.warning')
    expect(warning?.payload).toMatchObject({ kind: 'blocked_unknown' })
    const rawRecordId = (warning?.payload as { raw: { rawRecordId: string } }).raw.rawRecordId

    // The held row has NOT reached the stream while the cursor is stopped.
    expect(h.events.filter((e) => e.type === 'diagnostic')).toHaveLength(1)

    const released: InvocationCaptureReleaseResponse = await h.broker.captureRelease({
      invocationId: h.invocationId,
      rawRecordId,
      disposition: 'ignored-known',
      note: 'reviewed by operator',
    })
    expect(released).toMatchObject({
      released: true,
      disposition: 'ignored-known',
      resumedRecords: 1,
      capture: { state: 'open', deferredCount: 0 },
    })

    // The release is a COMMITTED fact on the ordinary normalized stream, not an
    // RPC side effect, and the held row normalized behind it.
    const releasedEvent = h.events.find((e) => e.type === 'capture.released')
    expect(releasedEvent?.payload).toMatchObject({
      rawRecordId,
      disposition: 'ignored-known',
      note: 'reviewed by operator',
      resumedRecords: 1,
    })
    expect(releasedEvent?.seq).toBe(released.releasedSeq)
    expect(h.events.filter((e) => e.type === 'diagnostic')).toHaveLength(2)

    const openSnapshot = await h.broker.snapshot({ invocationId: h.invocationId })
    expect(openSnapshot.capture).toMatchObject({ state: 'open', deferredCount: 0 })
  })

  test('releasing a record that is not blocking is refused with the blocking record named', async () => {
    const h = durableBroker('inv_release_2')
    await h.broker.start({ spec: spec(h.invocationId) })
    h.controller.captureRow(
      'queue-operation:hold',
      {},
      { disposition: 'blocked-unknown', family: 'turn-bracket', message: 'unknown op' }
    )

    await expect(
      h.broker.captureRelease({
        invocationId: h.invocationId,
        rawRecordId: 'raw_999999',
        disposition: 'ignored-known',
      })
    ).rejects.toMatchObject({
      code: -32602,
      data: { reason: CAPTURE_RELEASE_NOT_BLOCKED, capture: { state: 'blocked' } },
    })
  })

  test('every emitted envelope carries provenance', async () => {
    const h = durableBroker('inv_release_3')
    await h.broker.start({ spec: spec(h.invocationId) })
    h.controller.captureRow('known.row', { n: 1 }, { disposition: 'normalized' })

    expect(h.events.length).toBeGreaterThan(0)
    for (const event of h.events) {
      expect({ type: event.type, hasProvenance: event.provenance !== undefined }).toEqual({
        type: event.type,
        hasProvenance: true,
      })
      expect(event.provenance?.normalizer.name.length).toBeGreaterThan(0)
    }
    // The event minted while normalizing a raw record points back at it.
    const diagnostic = h.events.find((e) => e.type === 'diagnostic')
    expect(diagnostic?.provenance).toMatchObject({
      sourceKind: 'provider-jsonl',
      nativeType: 'known.row',
      rawRecordId: 'raw_000001',
    })
    // A broker decision is broker-authored, never attributed to the provider.
    const accepted = h.events.find((e) => e.type === 'invocation.ready')
    expect(accepted?.provenance).toMatchObject({ sourceKind: 'broker' })
  })
})

describe('invocation.capture.release params validation', () => {
  const call = (params: unknown) =>
    validateCommand({ jsonrpc: '2.0', id: 1, method: 'invocation.capture.release', params })

  test('accepts an ignored-known release', () => {
    expect(() =>
      call({ invocationId: 'inv_1', rawRecordId: 'raw_000001', disposition: 'ignored-known' })
    ).not.toThrow()
  })

  test('a normalized-as release must carry the event the operator authored', () => {
    expect(() =>
      call({ invocationId: 'inv_1', rawRecordId: 'raw_000001', disposition: 'normalized-as' })
    ).toThrow()
    expect(() =>
      call({
        invocationId: 'inv_1',
        rawRecordId: 'raw_000001',
        disposition: 'normalized-as',
        normalizedAs: { type: 'submission.cancelled', payload: { submissionId: 's1' } },
      })
    ).not.toThrow()
  })

  test('an operator cannot author an event type the contract does not define', () => {
    expect(() =>
      call({
        invocationId: 'inv_1',
        rawRecordId: 'raw_000001',
        disposition: 'normalized-as',
        normalizedAs: { type: 'not.a.real.event', payload: {} },
      })
    ).toThrow()
  })

  test('an empty rawRecordId is refused', () => {
    expect(() =>
      call({ invocationId: 'inv_1', rawRecordId: '', disposition: 'ignored-known' })
    ).toThrow()
  })
})
