import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationId,
} from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { createBroker } from '../src/broker'
import type { Driver, DriverContext } from '../src/drivers/driver'
import type { EventLedger } from '../src/event-ledger'
import { createEventLedger } from '../src/event-ledger'
import type { LedgerStorageFailure } from '../src/ledger-commit'
import { createCommittedEventPublisher } from '../src/ledger-commit'
import { noopCapabilities, noopSpec } from './helpers'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirs: string[] = []
const ledgers: EventLedger[] = []

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'harness-broker-ledger-durability-'))
  dirs.push(dir)
  return dir
}

function openLedger(dir: string): EventLedger {
  const ledger = createEventLedger({ path: join(dir, 'events.ndjson') })
  ledgers.push(ledger)
  return ledger
}

afterEach(() => {
  while (ledgers.length > 0) {
    ledgers.pop()?.close()
  }
  while (dirs.length > 0) {
    const dir = dirs.pop()
    if (dir === undefined) continue
    try {
      chmodSync(dir, 0o700)
    } catch {
      // Already writable, or already gone.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

const event = (
  invocationId: string,
  seq: number,
  type: InvocationEventEnvelope['type'] = 'diagnostic',
  payload: Record<string, unknown> = { message: 'x' }
): InvocationEventEnvelope =>
  ({
    invocationId,
    seq,
    time: new Date(seq * 1000).toISOString(),
    type,
    payload,
  }) as unknown as InvocationEventEnvelope

const testSpec = (invocationId: string): HarnessInvocationSpec =>
  noopSpec({
    invocationId,
    harness: { frontend: 'durability', provider: 'test', driver: 'durability-driver' },
    process: {
      command: 'durability-driver',
      args: [],
      cwd: process.cwd(),
      harnessTransport: { kind: 'pipes' },
    },
    interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'durability-driver' },
  })

interface DurabilityDriver extends Driver {
  /** Emit an extra event from the driver seam, as a live harness would. */
  emitFromDriver(type: 'diagnostic', payload: Record<string, unknown>): void
  readonly stopped: () => boolean
  readonly disposed: () => boolean
}

const createDurabilityDriver = (): DurabilityDriver => {
  let ctx: DriverContext | undefined
  let stopped = false
  let disposed = false
  return {
    kind: 'durability-driver',
    version: 'test',
    capabilities: () => noopCapabilities,
    start: async (_spec, driverCtx) => {
      ctx = driverCtx
      return { ok: true }
    },
    applyInputNow: async (input) => {
      ctx?.emit('turn.started', { turnId: 'turn_durability_1', inputId: input.inputId })
      return { turnId: 'turn_durability_1' }
    },
    interrupt: async () => ({ accepted: false, effect: 'unsupported' }),
    stop: async () => {
      stopped = true
      return { accepted: true, state: 'exited' }
    },
    dispose: async () => {
      disposed = true
      ctx = undefined
    },
    emitFromDriver: (type, payload) => {
      ctx?.emit(type, payload)
    },
    stopped: () => stopped,
    disposed: () => disposed,
  }
}

/**
 * Wrap a real ledger so a specific append can be made to fail the way the
 * filesystem would — EROFS on a read-only mount, ENOSPC on a full disk.
 */
function failingLedger(inner: EventLedger, shouldFail: () => NodeJS.ErrnoException | undefined) {
  const ledger: EventLedger = {
    ...inner,
    appendSync(evt) {
      const failure = shouldFail()
      if (failure !== undefined) {
        throw failure
      }
      return inner.appendSync(evt)
    },
    append(evt) {
      try {
        return Promise.resolve(ledger.appendSync(evt))
      } catch (error) {
        return Promise.reject(error)
      }
    },
  }
  return ledger
}

function errno(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException
  error.code = code
  return error
}

// ---------------------------------------------------------------------------
// (a) append rejects → zero publications after, typed failure surfaced
// ---------------------------------------------------------------------------

describe('T-07861 commit-before-publish, fail closed', () => {
  test('a rejected append publishes nothing for that event or any later one, and fails the invocation typed', async () => {
    const dir = scratchDir()
    const inner = openLedger(dir)
    // A COUNTER, not a flag: the storage terminal is emitted synchronously from
    // inside the failing emit, so a flag cleared after that call still poisons
    // the terminal's own append.
    let failNextAppends = 0
    const ledger = failingLedger(inner, () =>
      failNextAppends-- > 0
        ? errno('EROFS', 'EROFS: read-only file system, open events.ndjson')
        : undefined
    )
    const driver = createDurabilityDriver()
    const published: InvocationEventEnvelope[] = []

    const broker = createBroker({
      drivers: [driver],
      eventLedger: ledger,
      onEvent: (evt) => published.push(evt),
    })

    await broker.start({ spec: testSpec('inv_fail_closed') })
    const publishedBeforeFailure = published.length
    expect(publishedBeforeFailure).toBeGreaterThan(0)

    // EROFS for exactly the next append: the emitted event must NOT be
    // published, while the storage terminal that follows it can still commit.
    failNextAppends = 1
    driver.emitFromDriver('diagnostic', { level: 'warn', message: 'lost to a read-only ledger' })

    expect(published.map((evt) => evt.payload)).not.toContainEqual({
      level: 'warn',
      message: 'lost to a read-only ledger',
    })

    // The invocation transitions to the typed storage failure. That terminal is
    // the ONE event still allowed through, and only because it committed (the
    // injected failure was scoped to the diagnostic above).
    const terminal = published.at(-1)
    expect(terminal?.type).toBe('invocation.failed')
    expect(terminal?.payload).toMatchObject({ reason: 'ledger_append_failed' })

    // Fail closed stays closed: a later event on this invocation publishes
    // nothing even though the ledger is writable again. Asserted BEFORE any
    // await, while the driver context is still live — the teardown below
    // detaches it, which would make this a vacuously passing assertion.
    const afterTerminal = published.length
    driver.emitFromDriver('diagnostic', { level: 'warn', message: 'still suppressed' })
    expect(published.length).toBe(afterTerminal)

    await expect(
      broker.status({ invocationId: 'inv_fail_closed' as InvocationId })
    ).resolves.toMatchObject({ state: 'failed' })

    // ...and the driver was stopped/disposed cleanly.
    await Bun.sleep(10)
    expect(driver.stopped()).toBe(true)
    expect(driver.disposed()).toBe(true)

    // The controller's next actuating RPC sees the typed storage error.
    await expect(
      broker.input({
        invocationId: 'inv_fail_closed' as InvocationId,
        input: {
          inputId: 'in_after_failure',
          kind: 'user',
          content: [{ type: 'text', text: 'hi' }],
        },
      })
    ).rejects.toMatchObject({
      code: BrokerErrorCode.ResourceError,
      data: { reason: 'ledger_append_failed' },
    })
  })

  test('a disk-full ledger commits nothing and leaves no partially published event on disk', async () => {
    const dir = scratchDir()
    const path = join(dir, 'events.ndjson')
    const inner = openLedger(dir)
    let failMode: NodeJS.ErrnoException | undefined
    const ledger = failingLedger(inner, () => failMode)
    const driver = createDurabilityDriver()
    const published: InvocationEventEnvelope[] = []

    const broker = createBroker({
      drivers: [driver],
      eventLedger: ledger,
      onEvent: (evt) => published.push(evt),
    })
    await broker.start({ spec: testSpec('inv_disk_full') })

    const committedBefore = readFileSync(path, 'utf8')
    // ENOSPC on EVERY subsequent append, including the storage terminal itself.
    failMode = errno('ENOSPC', 'ENOSPC: no space left on device, write')
    driver.emitFromDriver('diagnostic', { level: 'warn', message: 'disk is full' })

    // Nothing new was published and nothing new reached disk.
    expect(readFileSync(path, 'utf8')).toBe(committedBefore)
    expect(published.every((evt) => evt.type !== 'invocation.failed')).toBe(true)

    // With no committable terminal, the controller learns from its next RPC.
    failMode = undefined
    await expect(
      broker.input({
        invocationId: 'inv_disk_full' as InvocationId,
        input: { inputId: 'in_disk_full', kind: 'user', content: [{ type: 'text', text: 'hi' }] },
      })
    ).rejects.toMatchObject({
      code: BrokerErrorCode.ResourceError,
      data: { reason: 'ledger_append_failed' },
    })
  })

  test('a real read-only ledger directory surfaces the same fail-closed behaviour', async () => {
    const dir = scratchDir()
    const ledger = openLedger(dir)
    const driver = createDurabilityDriver()
    const published: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [driver],
      eventLedger: ledger,
      onEvent: (evt) => published.push(evt),
    })
    await broker.start({ spec: testSpec('inv_readonly') })

    // Real filesystem refusal — no injected error object anywhere in the path.
    chmodSync(join(dir, 'events.ndjson'), 0o400)
    const before = published.length
    driver.emitFromDriver('diagnostic', { level: 'warn', message: 'refused by the filesystem' })

    expect(published.slice(before).map((evt) => evt.type)).not.toContain('diagnostic')
    await expect(
      broker.interrupt({ invocationId: 'inv_readonly' as InvocationId, scope: 'turn' })
    ).rejects.toMatchObject({ code: BrokerErrorCode.ResourceError })
  })
})

describe('T-07861 committed-event publisher', () => {
  const publisherFixture = (failAt: (evt: InvocationEventEnvelope) => boolean) => {
    const dir = scratchDir()
    const inner = openLedger(dir)
    const published: InvocationEventEnvelope[] = []
    const failures: LedgerStorageFailure[] = []
    const ledger = failingLedger(inner, () => undefined)
    const guarded: EventLedger = {
      ...ledger,
      appendSync(evt) {
        if (failAt(evt)) {
          throw errno('ENOSPC', 'ENOSPC: no space left on device')
        }
        return inner.appendSync(evt)
      },
    }
    const publisher = createCommittedEventPublisher({
      ledger: guarded,
      publish: (evt) => published.push(evt),
      onStorageFailure: (failure) => failures.push(failure),
    })
    return { publisher, published, failures, ledger: inner }
  }

  test('every later event on a poisoned invocation is suppressed, and other invocations are untouched', () => {
    const { publisher, published, failures } = publisherFixture(
      (evt) => evt.invocationId === 'inv_poison' && evt.seq === 2
    )

    publisher.commitAndPublish(event('inv_poison', 1))
    publisher.commitAndPublish(event('inv_poison', 2))
    publisher.commitAndPublish(event('inv_poison', 3))
    publisher.commitAndPublish(event('inv_poison', 4))
    publisher.commitAndPublish(event('inv_healthy', 1))

    expect(published.map((evt) => `${evt.invocationId}#${evt.seq}`)).toEqual([
      'inv_poison#1',
      'inv_healthy#1',
    ])
    expect(failures).toEqual([
      {
        invocationId: 'inv_poison' as InvocationId,
        seq: 2,
        type: 'diagnostic',
        detail: 'ENOSPC: no space left on device',
      },
    ])
    // Only the poisoned invocation refuses actuation.
    expect(() => publisher.assertCommittable('inv_poison' as InvocationId)).toThrow(
      /event ledger append failed/
    )
    expect(() => publisher.assertCommittable('inv_healthy' as InvocationId)).not.toThrow()
  })

  test('the storage terminal gets exactly one commit attempt and publishes at most once', () => {
    const { publisher, published } = publisherFixture((evt) => evt.seq === 2)
    const terminal = (seq: number) =>
      event('inv_terminal', seq, 'invocation.failed', {
        message: 'Event ledger append failed: boom',
        reason: 'ledger_append_failed',
      })

    publisher.commitAndPublish(event('inv_terminal', 1))
    publisher.commitAndPublish(event('inv_terminal', 2))
    publisher.commitAndPublish(terminal(3))
    publisher.commitAndPublish(terminal(4))

    expect(published.map((evt) => `${evt.type}#${evt.seq}`)).toEqual([
      'diagnostic#1',
      'invocation.failed#3',
    ])
  })
})

// ---------------------------------------------------------------------------
// (c) partial-tail restart
// ---------------------------------------------------------------------------

describe('T-07861 startup trailing-segment repair', () => {
  test('a torn final record is truncated once, recorded as capture.warning, and seq continues', async () => {
    const dir = scratchDir()
    const path = join(dir, 'events.ndjson')
    const first = openLedger(dir)
    first.appendSync(event('inv_tail', 1))
    first.appendSync(event('inv_tail', 2))
    first.close()
    ledgers.pop()

    // Simulate a crash mid-append: a partial record with no terminating newline.
    const intact = readFileSync(path, 'utf8')
    writeFileSync(path, `${intact}{"invocationId":"inv_tail","seq":3,"ty`)

    const reopened = openLedger(dir)
    const repair = reopened.tailRepair()
    expect(repair).toMatchObject({
      truncatedAtOffset: intact.length,
      lastIntact: { invocationId: 'inv_tail', seq: 2 },
    })
    // The file is repaired on disk, so nothing torn survives the restart.
    expect(readFileSync(path, 'utf8')).toBe(intact)
    // seq continues from the last INTACT record — no duplicate, no skip.
    expect(reopened.currentSeq('inv_tail' as InvocationId)).toBe(2)
    expect((await reopened.eventsSince('inv_tail' as InvocationId, 0)).map((e) => e.seq)).toEqual([
      1, 2,
    ])

    // Repair is once-only: a third open sees an intact file and repairs nothing.
    reopened.close()
    ledgers.pop()
    const third = openLedger(dir)
    expect(third.tailRepair()).toBeUndefined()
  })

  test('the broker commits exactly one ledger_tail_repaired warning and resumes seq after it', async () => {
    const dir = scratchDir()
    const path = join(dir, 'events.ndjson')
    const first = openLedger(dir)
    first.appendSync(event('inv_warn', 1))
    first.appendSync(event('inv_warn', 2))
    first.close()
    ledgers.pop()
    writeFileSync(path, `${readFileSync(path, 'utf8')}{"invocationId":"inv_warn","seq":3`)

    const published: InvocationEventEnvelope[] = []
    const ledger = openLedger(dir)
    createBroker({
      drivers: [createDurabilityDriver()],
      eventLedger: ledger,
      onEvent: (evt) => published.push(evt),
    })

    expect(published).toHaveLength(1)
    expect(published[0]).toMatchObject({
      invocationId: 'inv_warn',
      seq: 3,
      type: 'capture.warning',
      payload: { kind: 'ledger_tail_repaired' },
    })
    // Committed like any other event, so replay delivers it too.
    expect((await ledger.eventsSince('inv_warn' as InvocationId, 2)).map((e) => e.type)).toEqual([
      'capture.warning',
    ])
  })

  test('an unreadable INTERIOR record is typed corruption, never a silent skip', () => {
    const dir = scratchDir()
    const path = join(dir, 'events.ndjson')
    const first = openLedger(dir)
    first.appendSync(event('inv_interior', 1))
    first.appendSync(event('inv_interior', 2))
    first.close()
    ledgers.pop()

    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean)
    writeFileSync(path, `${lines[0]}\nnot-json-at-all\n${lines[1]}\n`)

    expect(() => openLedger(dir)).toThrow(/corrupt at byte offset/)
  })
})

// ---------------------------------------------------------------------------
// (d) ack + floor survive restart / (f) prune never crosses the floor
// ---------------------------------------------------------------------------

describe('T-07861 durable consumer state', () => {
  test('acknowledged-through seq and retention floor survive a broker restart', async () => {
    const dir = scratchDir()
    const before = openLedger(dir)
    for (let seq = 1; seq <= 6; seq += 1) {
      before.appendSync(event('inv_durable', seq))
    }
    await before.ackEvents('inv_durable' as InvocationId, 4)
    await before.prune({ activeInvocationIds: [] })
    expect(await before.retentionFloorSeq('inv_durable' as InvocationId)).toBe(4)
    // Drop the process WITHOUT a clean close — the kill -9 shape.
    ledgers.pop()

    const after = openLedger(dir)
    expect(await after.retentionFloorSeq('inv_durable' as InvocationId)).toBe(4)
    // The ack itself is durable too: a lower re-ack is still refused.
    await expect(after.ackEvents('inv_durable' as InvocationId, 3)).rejects.toMatchObject({
      code: BrokerErrorCode.EventReplayUnavailable,
    })
    await expect(after.ackEvents('inv_durable' as InvocationId, 4)).resolves.toEqual({
      ackedThroughSeq: 4,
    })
    // currentSeq does not regress below the persisted floor after pruning.
    expect(after.currentSeq('inv_durable' as InvocationId)).toBe(6)
  })

  test('currentSeq never regresses below the floor even when pruning emptied the file', async () => {
    const dir = scratchDir()
    const before = openLedger(dir)
    for (let seq = 1; seq <= 3; seq += 1) {
      before.appendSync(event('inv_emptied', seq))
    }
    await before.ackEvents('inv_emptied' as InvocationId, 3)
    await before.prune({ activeInvocationIds: [] })
    ledgers.pop()

    const after = openLedger(dir)
    expect(after.currentSeq('inv_emptied' as InvocationId)).toBe(3)
  })

  test('prune only ever advances the persisted floor', async () => {
    const dir = scratchDir()
    const ledger = openLedger(dir)
    for (let seq = 1; seq <= 5; seq += 1) {
      ledger.appendSync(event('inv_floor', seq))
    }
    await ledger.ackEvents('inv_floor' as InvocationId, 4)
    await ledger.prune({ activeInvocationIds: [] })
    expect(await ledger.retentionFloorSeq('inv_floor' as InvocationId)).toBe(4)

    // Re-acking at the same seq and pruning again is a no-op, not a rollback.
    await ledger.ackEvents('inv_floor' as InvocationId, 4)
    await ledger.prune({ activeInvocationIds: [] })
    expect(await ledger.retentionFloorSeq('inv_floor' as InvocationId)).toBe(4)
    expect((await ledger.eventsSince('inv_floor' as InvocationId, 4)).map((e) => e.seq)).toEqual([
      5,
    ])
  })

  test('a restarted broker resumes seq after the last committed record', async () => {
    const dir = scratchDir()
    const before = openLedger(dir)
    before.appendSync(event('inv_resume', 1))
    before.appendSync(event('inv_resume', 2))
    ledgers.pop()

    const ledger = openLedger(dir)
    const published: InvocationEventEnvelope[] = []
    const broker = createBroker({
      drivers: [createDurabilityDriver()],
      eventLedger: ledger,
      onEvent: (evt) => published.push(evt),
    })
    await broker.start({ spec: testSpec('inv_resume') })

    // No collision with the surviving seq 1/2, and no gap either.
    expect(published[0]?.seq).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// (e) below-floor reads fail typed
// ---------------------------------------------------------------------------

describe('T-07861 below-floor replay', () => {
  const attachRequest = (lastProjectedSeq: number) => ({
    runtimeId: 'rt_below_floor',
    hostSessionId: 'hs_below_floor',
    generation: 1,
    invocationId: 'inv_below_floor' as InvocationId,
    startRequestHash: 'sha_start',
    selectedProfileHash: 'sha_profile',
    controllerInstanceId: 'ctl_1',
    attachToken: 'token',
    lastProjectedSeq,
  })

  test('eventsSince and attach both reject below the floor with the same typed shape', async () => {
    const dir = scratchDir()
    const ledger = openLedger(dir)
    const broker = createBroker({ drivers: [createDurabilityDriver()], eventLedger: ledger })
    await broker.start({ spec: testSpec('inv_below_floor') })

    // Advance the floor the way retention does: ack, then prune the (now
    // inactive, from the ledger's point of view) invocation.
    const current = ledger.currentSeq('inv_below_floor' as InvocationId)
    await ledger.ackEvents('inv_below_floor' as InvocationId, current)
    await ledger.prune({ activeInvocationIds: [] })
    expect(await ledger.retentionFloorSeq('inv_below_floor' as InvocationId)).toBe(current)

    const expected = {
      code: BrokerErrorCode.EventReplayUnavailable,
      data: {
        reason: 'replay_below_floor',
        invocationId: 'inv_below_floor',
        afterSeq: 0,
        retentionFloorSeq: current,
        currentSeq: current,
      },
    }

    await expect(
      broker.eventsSince({ invocationId: 'inv_below_floor' as InvocationId, afterSeq: 0 })
    ).rejects.toMatchObject(expected)
    await expect(broker.attach(attachRequest(0))).rejects.toMatchObject(expected)
  })

  test('attach at or above the floor still succeeds', async () => {
    const dir = scratchDir()
    const ledger = openLedger(dir)
    const broker = createBroker({ drivers: [createDurabilityDriver()], eventLedger: ledger })
    await broker.start({ spec: testSpec('inv_below_floor') })

    const current = ledger.currentSeq('inv_below_floor' as InvocationId)
    await ledger.ackEvents('inv_below_floor' as InvocationId, current)
    await ledger.prune({ activeInvocationIds: [] })

    await expect(broker.attach(attachRequest(current))).resolves.toMatchObject({
      attached: true,
      retentionFloorSeq: current,
    })
  })
})
