import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  EventFamily,
  HarnessInvocationSpec,
  InvocationEventEnvelope,
} from 'spaces-harness-broker-protocol'
import {
  CAPTURE_RELEASE_NOT_BLOCKED,
  CommandValidationError,
  LOAD_BEARING_EVENT_FAMILIES,
  validateCommand,
} from 'spaces-harness-broker-protocol'
import { createBroker } from '../../src/broker'
import { createEventLedger } from '../../src/event-ledger'
import { createTestDriver } from '../../src/testing/test-driver'
import { invocationIdFrom } from '../ids'

const roots: string[] = []
process.on('exit', () => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const spec = (invocationId: string): HarnessInvocationSpec => ({
  specVersion: 'harness-broker.invocation/v1',
  invocationId: invocationIdFrom(invocationId),
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
  return {
    broker,
    driver,
    controller,
    events,
    logged,
    dir,
    invocationId: invocationIdFrom(invocationId),
  }
}

describe('capture through the real broker: a blocked-unknown never stops the stream', () => {
  // Lance, 2026-09-02: "We should never halt when an unknown event arrives.
  // Harnesses are upgraded all the time; we don't want to hard-fail our entire
  // fleet when we haven't handled an upgraded new event. It should warn
  // loudly." One row per load-bearing family.
  test.each([...LOAD_BEARING_EVENT_FAMILIES] as EventFamily[])(
    'an unclassified load-bearing %s row warns and every later row still reaches the stream',
    async (family) => {
      const h = durableBroker(`inv_release_family_${family}`)
      await h.broker.start({ spec: spec(h.invocationId) })

      h.controller.captureRow('known.row', { n: 1 }, { disposition: 'normalized' })
      h.controller.captureRow(
        'queue-operation:reprioritize',
        { operation: 'reprioritize' },
        {
          disposition: 'blocked-unknown',
          family,
          message: `unknown ${family} row`,
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
            family,
            loadBearing: true,
            count: 1,
          },
        ],
      })
      expect(snapshot.capture?.blockedOn).toBeUndefined()
      expect(snapshot.state).toBe('ready')

      const warning = h.events.find((e) => e.type === 'capture.warning')
      expect(warning?.payload).toMatchObject({
        kind: 'blocked_unknown',
        raw: {
          rawRecordId: 'raw_000002',
          nativeType: 'queue-operation:reprioritize',
          family,
          cursorHalted: false,
          loadBearing: true,
        },
      })

      // The rows before AND after the unclassified one reached the stream,
      // which is the whole point: the halt used to hold them until an operator
      // released the block.
      expect(
        h.events
          .filter((e) => e.type === 'diagnostic')
          .map((e) => (e.provenance as { nativeType?: string } | undefined)?.nativeType)
      ).toEqual(['known.row', 'later.row'])

      // And a human tailing broker.err saw ONE line without parsing ndjson.
      expect(h.logged).toEqual([
        `WARN harness-broker capture blocked_unknown invocationId=${h.invocationId} ` +
          `driver=test-driver family=${family} nativeType=queue-operation:reprioritize ` +
          `rawRecordId=raw_000002 loadBearing=true message=unknown ${family} row`,
      ])
    }
  )

  test('a repeated unknown native type logs once per (driver, nativeType, family) and is counted in snapshot.capture', async () => {
    const h = durableBroker('inv_release_rate_limit')
    await h.broker.start({ spec: spec(h.invocationId) })
    const blocked = (family: EventFamily, message: string) =>
      ({ disposition: 'blocked-unknown', family, message }) as const
    for (let n = 0; n < 5; n += 1) {
      h.controller.captureRow('mystery', { n }, blocked('conversation', 'Unknown row: mystery'))
    }
    // A different family on the same type is a different key: a driver that
    // reclassifies drift must not be silenced by the first key it hit.
    h.controller.captureRow('mystery', {}, blocked('diagnostic', 'Unknown row: mystery'))
    h.controller.captureRow('other', {}, blocked('conversation', 'Unknown row: other'))

    // Every record still warns on the STREAM — the rate limit is on the log.
    expect(h.events.filter((e) => e.type === 'capture.warning')).toHaveLength(7)
    expect(h.logged).toHaveLength(3)
    expect(h.logged.map((line) => /family=(\S+) nativeType=(\S+)/.exec(line)?.slice(1))).toEqual([
      ['conversation', 'mystery'],
      ['diagnostic', 'mystery'],
      ['conversation', 'other'],
    ])
    const snapshot = await h.broker.snapshot({ invocationId: h.invocationId })
    expect(
      snapshot.capture?.blockedUnknown?.map(
        ({ driver, nativeType, family, loadBearing, count }) => ({
          driver,
          nativeType,
          family,
          loadBearing,
          count,
        })
      )
    ).toEqual([
      {
        driver: 'test-driver',
        nativeType: 'mystery',
        family: 'conversation',
        loadBearing: true,
        count: 5,
      },
      {
        driver: 'test-driver',
        nativeType: 'mystery',
        family: 'diagnostic',
        loadBearing: false,
        count: 1,
      },
      {
        driver: 'test-driver',
        nativeType: 'other',
        family: 'conversation',
        loadBearing: true,
        count: 1,
      },
    ])
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
    const start = h.driver.start.bind(h.driver)
    h.driver.start = async (spec, ctx) => {
      const result = await start(spec, ctx)
      ctx.capture?.ingest(
        {
          provider: 'test',
          driverKind: 'test-driver',
          sourceKind: 'provider-jsonl',
          sourceKey: 'test-transcript',
          nativeType: 'cursor.row',
          sourceCursor: { byteOffset: 42, line: 7 },
          rawBytes: Buffer.from('{"type":"cursor"}'),
        },
        (captured) => {
          ctx.emit(
            'diagnostic',
            { level: 'info', source: 'harness', message: 'cursor.row' },
            { provenance: captured.provenance() }
          )
          return { disposition: 'normalized' }
        }
      )
      return result
    }
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
    const diagnostic = h.events.find(
      (e) => e.type === 'diagnostic' && e.payload.message === 'cursor.row'
    )
    expect(diagnostic?.provenance).toMatchObject({
      sourceKind: 'provider-jsonl',
      nativeType: 'cursor.row',
      rawRecordId: 'raw_000001',
      sourceCursor: { byteOffset: 42, line: 7 },
      normalizer: { name: h.driver.kind, version: h.driver.version },
    })
    expect(diagnostic?.provenance?.rawSha256).toMatch(/^[a-f0-9]{64}$/)
    // A broker decision is broker-authored, never attributed to the provider.
    const accepted = h.events.find((e) => e.type === 'invocation.ready')
    expect(accepted?.provenance).toMatchObject({ sourceKind: 'broker' })
  })
})

describe('invocation.capture.release params validation', () => {
  const call = (params: unknown) =>
    validateCommand({ jsonrpc: '2.0', id: 1, method: 'invocation.capture.release', params })
  const base = { invocationId: 'inv_1', rawRecordId: 'raw_000001' }

  test.each([
    { row: 'ignored-known release', params: { ...base, disposition: 'ignored-known' } },
    {
      row: 'normalized-as release carrying a contract event',
      params: {
        ...base,
        disposition: 'normalized-as',
        normalizedAs: { type: 'submission.cancelled', payload: { submissionId: 's1' } },
      },
    },
  ])('capture.release params accept an $row', ({ params }) => {
    expect(call(params)).toMatchObject({ method: 'invocation.capture.release', params })
  })

  test.each([
    {
      row: 'a normalized-as release with no event',
      params: { ...base, disposition: 'normalized-as' },
      path: 'params.normalizedAs',
      code: 'required',
    },
    {
      row: 'a normalized-as release naming an event the contract does not define',
      params: {
        ...base,
        disposition: 'normalized-as',
        normalizedAs: { type: 'not.a.real.event', payload: {} },
      },
      path: 'params.normalizedAs.type',
      code: 'invalid_event_type',
    },
    {
      row: 'an empty rawRecordId',
      params: { ...base, rawRecordId: '', disposition: 'ignored-known' },
      path: 'params.rawRecordId',
      code: 'required',
    },
  ])('capture.release params refuse $row, naming the field', ({ params, path, code }) => {
    let thrown: unknown
    try {
      call(params)
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(CommandValidationError)
    expect((thrown as CommandValidationError).issues).toEqual([
      expect.objectContaining({ path, code }),
    ])
  })
})
