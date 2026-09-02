import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { HarnessInvocationSpec, InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
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
  const logged: string[] = []
  const { driver, controller } = createTestDriver()
  const broker = createBroker({
    drivers: [driver],
    eventLedger: createEventLedger({ path: join(dir, 'events.ndjson') }),
    captureDir: dir,
    onEvent: (event) => events.push(event),
    logWarn: (line) => void logged.push(line),
  })
  return { broker, controller, events, logged, dir, invocationId }
}

describe('capture through the real broker: a blocked-unknown never stops the stream', () => {
  test('an unclassified load-bearing row warns and every later row still reaches the stream', async () => {
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
    h.controller.captureRow('later.row', { n: 2 }, { disposition: 'normalized' })

    // §5: capture state is visible in `snapshot` — and it is OPEN. The seat
    // keeps running, and so does the normalization cursor (T-07883).
    const snapshot = await h.broker.snapshot({ invocationId: h.invocationId })
    expect(snapshot.capture).toMatchObject({
      state: 'open',
      deferredCount: 0,
      blockedUnknown: [
        {
          driver: 'test-driver',
          nativeType: 'queue-operation:reprioritize',
          family: 'submission-disposition',
          loadBearing: true,
          count: 1,
        },
      ],
    })
    expect(snapshot.capture?.blockedOn).toBeUndefined()
    expect(snapshot.state).toBe('ready')

    const warning = h.events.find((e) => e.type === 'capture.warning')
    expect(warning?.payload).toMatchObject({ kind: 'blocked_unknown' })
    expect((warning?.payload as { raw: { cursorHalted: boolean } }).raw.cursorHalted).toBe(false)

    // The row AFTER the unclassified one reached the stream, which is the whole
    // point: the halt used to hold it until an operator released the block.
    expect(h.events.filter((e) => e.type === 'diagnostic')).toHaveLength(2)

    // And a human tailing broker.err saw it without parsing ndjson.
    expect(h.logged).toHaveLength(1)
    expect(h.logged[0]).toContain('WARN harness-broker capture blocked_unknown')
    expect(h.logged[0]).toContain('nativeType=queue-operation:reprioritize')
    expect(h.logged[0]).toContain('family=submission-disposition')
    expect(h.logged[0]).toContain(`invocationId=${h.invocationId}`)
  })

  test('the release RPC stays on the wire and refuses, naming that capture is open', async () => {
    const h = durableBroker('inv_release_2')
    await h.broker.start({ spec: spec(h.invocationId) })
    h.controller.captureRow(
      'queue-operation:hold',
      {},
      { disposition: 'blocked-unknown', family: 'turn-bracket', message: 'unknown op' }
    )
    const warning = h.events.find((e) => e.type === 'capture.warning')
    const rawRecordId = (warning?.payload as { raw: { rawRecordId: string } }).raw.rawRecordId

    // T-07883 item 5: `hrc capture release` still resolves; the answer is that
    // there is nothing to release, not a broker fault. Even the record that
    // WAS the blocked-unknown is refused, because nothing blocks.
    for (const target of [rawRecordId, 'raw_999999']) {
      await expect(
        h.broker.captureRelease({
          invocationId: h.invocationId,
          rawRecordId: target,
          disposition: 'ignored-known',
        })
      ).rejects.toMatchObject({
        code: -32602,
        data: { reason: CAPTURE_RELEASE_NOT_BLOCKED, capture: { state: 'open' } },
      })
    }
    expect(h.events.find((e) => e.type === 'capture.released')).toBeUndefined()
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
