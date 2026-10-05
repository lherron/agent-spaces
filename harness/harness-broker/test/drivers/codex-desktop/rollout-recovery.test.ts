import { afterEach, describe, expect, test } from 'bun:test'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../../../src/event-ledger'
import {
  noticeData,
  observerBroker,
  removeTempDirs,
  spec,
  tempDir,
  waitFor,
  withDriver,
} from './observer-harness'
import { agentMessage, itemRow, row, toolTurnRows, userMessage } from './rollout-rows'

afterEach(removeTempDirs)

function countOf(events: InvocationEventEnvelope[], type: string, turnId?: string): number {
  return events.filter(
    (event) => event.type === type && (turnId === undefined || event.turnId === (turnId as never))
  ).length
}

function turnCompleted(events: InvocationEventEnvelope[], turnId: string): boolean {
  return countOf(events, 'turn.completed', turnId) > 0
}

describe('codex-desktop rollout recovery and epochs', () => {
  test('stays ready-degraded until a delayed rollout materializes and preserves partial lines', async () => {
    const dir = tempDir()
    const path = join(dir, 'delayed.jsonl')
    const invocationId = 'inv-desktop-delayed' as InvocationId
    const { broker, events } = observerBroker({ captureDir: dir })
    await broker.start({ spec: spec(path, invocationId) })
    const driverLiveness = async () =>
      (await broker.status({ invocationId, probeLiveness: true })).liveness?.driver
    expect(await driverLiveness()).toMatchObject({ state: 'degraded' })

    const started = row({ type: 'task_started', turn_id: 'turn-delayed' }, 1)
    writeFileSync(path, started.slice(0, -1))
    await Bun.sleep(40)
    expect(countOf(events, 'turn.started')).toBe(0)
    appendFileSync(path, '\n')
    await waitFor(() => countOf(events, 'turn.started') > 0)
    expect(await driverLiveness()).toEqual({ state: 'healthy' })
  })

  test('replacement and observer restart retain native dedupe and append only new history', async () => {
    const dir = tempDir()
    const path = join(dir, 'restart.jsonl')
    const invocationId = 'inv-desktop-restart' as InvocationId
    const turn1 = toolTurnRows('thread-desktop', 'turn-1', 1)
    writeFileSync(path, turn1)
    const ledgerPath = join(dir, 'events.ndjson')
    const firstLedger = createEventLedger({ path: ledgerPath })
    const first = observerBroker({ captureDir: dir, eventLedger: firstLedger })
    await first.broker.start({ spec: spec(path, invocationId) })
    await waitFor(() => countOf(first.events, 'turn.completed') > 0)
    await first.broker.stop({ invocationId, reason: 'observer restart' })
    firstLedger.close()

    // Same native history plus a new turn: replay must not remint turn-1.
    const turn2 = toolTurnRows('thread-desktop', 'turn-2', 5)
    writeFileSync(path, turn1 + turn2)
    const secondLedger = createEventLedger({ path: ledgerPath })
    const second = observerBroker({ captureDir: dir, eventLedger: secondLedger })
    await second.broker.start({ spec: spec(path, invocationId) })
    await waitFor(() => turnCompleted(second.events, 'turn-2'))
    expect(countOf(second.events, 'turn.started', 'turn-1')).toBe(0)
    expect(countOf(second.events, 'turn.started', 'turn-2')).toBe(1)
    expect(countOf(second.events, 'tool.call.started', 'turn-1')).toBe(0)
    expect(countOf(second.events, 'tool.call.completed', 'turn-1')).toBe(0)
    expect(countOf(second.events, 'tool.call.started', 'turn-2')).toBe(1)
    expect(countOf(second.events, 'tool.call.completed', 'turn-2')).toBe(2)
    secondLedger.close()
  })

  test('fresh recovery replays all records so HRC can dedupe committed projection identities', async () => {
    const dir = tempDir()
    const path = join(dir, 'fresh-recovery.jsonl')
    const threadId = 'thread-desktop'
    const prefix = row({ type: 'task_started', turn_id: 'turn-crossing' }, 1)
    const boundary = itemRow(
      threadId,
      'turn-crossing',
      userMessage('user-boundary', 'human-boundary', 'boundary input'),
      2
    )
    const tail =
      itemRow(
        threadId,
        'turn-crossing',
        agentMessage('assistant-after-boundary', 'final_answer', 'recovered'),
        3
      ) + row({ type: 'task_complete', turn_id: 'turn-crossing' }, 4)
    const trailingPartial = '{"timestamp"'
    writeFileSync(path, prefix + boundary + tail + trailingPartial)
    const { broker, events } = observerBroker({ captureDir: join(dir, 'replacement-capture') })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-fresh-recovery'), {
        recoveryBoundary: {
          sourceKind: 'provider-jsonl',
          sourceEpoch: 'prior-capture-epoch',
          furthestCommittedRecord: {
            rawRecordId: 'prior-raw-boundary',
            byteOffset: Buffer.byteLength(prefix),
            line: 2,
            rawSha256: 'prior-capture-hash',
            nativeType: 'event_msg:item_completed',
          },
          committedProjections: [
            { seq: 8, type: 'user.message', turnId: 'turn-crossing', itemId: 'user-boundary' },
          ],
          appliedThroughSeq: 8,
          empty: false,
        },
      }),
    })
    await waitFor(() => countOf(events, 'turn.completed') > 0)

    for (const type of [
      'turn.started',
      'user.message',
      'turn.attributed',
      'assistant.message.completed',
      'turn.completed',
    ]) {
      expect(countOf(events, type)).toBe(1)
    }
    expect(noticeData(events, 'CODEX_DESKTOP_RECOVERY_BOUNDARY_APPLIED')).toMatchObject({
      replayByteOffset: 0,
      replaySnapshotBytes: Buffer.byteLength(prefix + boundary + tail + trailingPartial),
      replaySnapshotCompleteRecords: 4,
      replaySnapshotTrailingPartialBytes: Buffer.byteLength(trailingPartial),
      furthestCommittedByteOffset: Buffer.byteLength(prefix),
      committedProjectionCount: 1,
    })
  })

  test('never treats the legacy producer EOF watermark as a committed recovery boundary', async () => {
    const dir = tempDir()
    const path = join(dir, 'unsafe-producer-eof.jsonl')
    const history =
      row({ type: 'task_started', turn_id: 'turn-below-producer-eof' }, 1) +
      row({ type: 'task_complete', turn_id: 'turn-below-producer-eof' }, 2)
    writeFileSync(path, history)
    const { broker, events } = observerBroker({ captureDir: dir })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-unsafe-eof'), {
        adoptionWatermark: { byteOffset: Buffer.byteLength(history) },
      }),
    })
    await waitFor(() => countOf(events, 'turn.completed') > 0)
    expect(countOf(events, 'turn.started')).toBe(1)
    expect(countOf(events, 'turn.completed')).toBe(1)
  })

  test('fresh recovery republishes delayed output carrying an earlier boundary provenance', async () => {
    const dir = tempDir()
    const path = join(dir, 'delayed-projection-recovery.jsonl')
    const prefix = row({ type: 'task_started', turn_id: 'turn-delayed-projection' }, 1)
    const held = itemRow(
      'thread-desktop',
      'turn-delayed-projection',
      agentMessage('assistant-delayed-projection', 'final_answer', 'delayed projection'),
      2
    )
    const laterApplied = row({ type: 'token_count', info: { total_tokens: 42 } }, 3)
    const terminal = row({ type: 'task_complete', turn_id: 'turn-delayed-projection' }, 4)
    writeFileSync(path, prefix + held + laterApplied + terminal)
    const boundaryOffset = Buffer.byteLength(prefix)
    const { broker, events } = observerBroker({ captureDir: join(dir, 'replacement-capture') })
    await broker.start({
      spec: withDriver(spec(path, 'inv-desktop-delayed-projection'), {
        recoveryBoundary: {
          sourceKind: 'provider-jsonl',
          furthestCommittedRecord: {
            rawRecordId: 'prior-raw-later-applied',
            byteOffset: Buffer.byteLength(prefix + held),
            rawSha256: 'prior-capture-hash',
          },
          earliestPendingRecord: {
            rawRecordId: 'prior-raw-pending-after-held',
            byteOffset: Buffer.byteLength(prefix + held + laterApplied),
          },
          committedProjections: [{ seq: 12, type: 'usage.updated', rawRecordId: 'raw-later' }],
          appliedThroughSeq: 12,
          empty: false,
        },
      }),
    })
    await waitFor(() => countOf(events, 'turn.completed') > 0)

    const assistant = events.find((event) => event.type === 'assistant.message.completed')
    expect(assistant?.payload).toMatchObject({ final: true })
    expect(assistant?.provenance.sourceCursor).toMatchObject({ byteOffset: boundaryOffset })
    expect(countOf(events, 'usage.updated')).toBe(1)
    expect(countOf(events, 'turn.completed')).toBe(1)
    expect(noticeData(events, 'CODEX_DESKTOP_RECOVERY_BOUNDARY_APPLIED')).toMatchObject({
      replayByteOffset: 0,
      committedProjectionCount: 1,
    })
  })

  test('detects a same-path replacement and observes the replacement epoch once', async () => {
    const dir = tempDir()
    const path = join(dir, 'replacement.jsonl')
    const original = [
      row({ type: 'task_started', turn_id: 'turn-original' }, 1),
      row({ type: 'task_complete', turn_id: 'turn-original' }, 2),
    ].join('')
    writeFileSync(path, original)
    const { broker, events } = observerBroker({ captureDir: dir })
    await broker.start({ spec: spec(path, 'inv-desktop-replacement') })
    await waitFor(() => turnCompleted(events, 'turn-original'))

    const replacementPrefix = `${' '.repeat(original.length - 1)}\n`
    writeFileSync(
      path,
      [
        replacementPrefix,
        row({ type: 'task_started', turn_id: 'turn-replacement' }, 3),
        row({ type: 'task_complete', turn_id: 'turn-replacement' }, 4),
      ].join('')
    )
    await waitFor(() => turnCompleted(events, 'turn-replacement'))
    expect(countOf(events, 'turn.started', 'turn-original')).toBe(1)
    expect(countOf(events, 'turn.started', 'turn-replacement')).toBe(1)
  })
})
