import { describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrokerErrorCode, type InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import { createEventLedger } from '../src/event-ledger'

const event = (
  invocationId: string,
  seq: number,
  type: InvocationEventEnvelope['type'] = 'diagnostic',
  payload: Record<string, unknown> = {}
): InvocationEventEnvelope => ({
  invocationId,
  seq,
  ts: new Date(seq * 1000).toISOString(),
  type,
  payload,
})

const withLedger = async (run: (ledger: ReturnType<typeof createEventLedger>) => Promise<void>) => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-broker-event-ledger-c1-'))
  try {
    await run(
      createEventLedger({
        path: join(dir, 'events.jsonl'),
      })
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

describe('event ledger red tests for T-01793 Phase C1', () => {
  test('append is idempotent for identical invocation/seq payloads but rejects conflicting duplicates', async () => {
    // T-01793 C1: the production ledger lives in src/event-ledger.ts. A duplicate
    // (invocationId, seq) with different event bytes is data corruption, not a
    // successful no-op.
    await withLedger(async (ledger) => {
      const first = event('inv_ledger_idempotent', 1, 'invocation.started', { pid: 123 })

      await expect(ledger.append(first)).resolves.toEqual({ appended: true })
      await expect(ledger.append(structuredClone(first))).resolves.toEqual({ appended: false })
      await expect(
        ledger.append(event('inv_ledger_idempotent', 1, 'invocation.started', { pid: 456 }))
      ).rejects.toMatchObject({
        code: BrokerErrorCode.ResourceError,
      })
    })
  })

  test('eventsSince returns per-invocation ordered seq greater than afterSeq', async () => {
    await withLedger(async (ledger) => {
      await ledger.append(event('inv_a', 1))
      await ledger.append(event('inv_b', 1))
      await ledger.append(event('inv_a', 3))
      await ledger.append(event('inv_a', 2))

      expect((await ledger.eventsSince('inv_a', 1)).map((item) => item.seq)).toEqual([2, 3])
      expect((await ledger.eventsSince('inv_b', 0)).map((item) => item.seq)).toEqual([1])
    })
  })

  test('ackEvents is monotonic per invocation and rejects lower throughSeq', async () => {
    await withLedger(async (ledger) => {
      await ledger.append(event('inv_ack', 1))
      await ledger.append(event('inv_ack', 2))

      await expect(ledger.ackEvents('inv_ack', 2)).resolves.toEqual({ ackedThroughSeq: 2 })
      await expect(ledger.ackEvents('inv_ack', 1)).rejects.toMatchObject({
        code: BrokerErrorCode.EventReplayUnavailable,
      })
    })
  })

  test('retention floor is per-invocation and active invocations are not pruned', async () => {
    await withLedger(async (ledger) => {
      for (let seq = 1; seq <= 5; seq += 1) {
        await ledger.append(event('inv_active', seq))
        await ledger.append(event('inv_inactive', seq))
      }

      await ledger.ackEvents('inv_active', 4)
      await ledger.ackEvents('inv_inactive', 4)
      await ledger.prune({ activeInvocationIds: ['inv_active'] })

      expect(await ledger.retentionFloorSeq('inv_active')).toBe(0)
      expect((await ledger.eventsSince('inv_active', 0)).map((item) => item.seq)).toEqual([
        1, 2, 3, 4, 5,
      ])
      expect(await ledger.retentionFloorSeq('inv_inactive')).toBe(4)
      await expect(ledger.eventsSince('inv_inactive', 3)).rejects.toMatchObject({
        code: BrokerErrorCode.EventReplayUnavailable,
      })
      expect((await ledger.eventsSince('inv_inactive', 4)).map((item) => item.seq)).toEqual([5])
    })
  })
})
