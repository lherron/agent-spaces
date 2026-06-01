import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import { BrokerErrorCode } from 'spaces-harness-broker-protocol'
import { BrokerError } from './errors'

export interface EventLedgerAppendResult {
  appended: boolean
}

export interface EventLedgerAckResult {
  ackedThroughSeq: number
}

export interface EventLedgerPruneOptions {
  activeInvocationIds: string[]
}

export interface EventLedger {
  append(event: InvocationEventEnvelope): Promise<EventLedgerAppendResult>
  eventsSince(invocationId: InvocationId, afterSeq: number): Promise<InvocationEventEnvelope[]>
  ackEvents(invocationId: InvocationId, throughSeq: number): Promise<EventLedgerAckResult>
  retentionFloorSeq(invocationId: InvocationId): Promise<number>
  currentSeq(invocationId: InvocationId): number
  prune(options: EventLedgerPruneOptions): Promise<void>
}

export interface EventLedgerOptions {
  path?: string | undefined
}

interface StoredEvent {
  event: InvocationEventEnvelope
  bytes: string
}

const DEFAULT_RETENTION_FLOOR = 0

export function createEventLedger(options: EventLedgerOptions = {}): EventLedger {
  const path = options.path
  const eventsByInvocation = new Map<string, Map<number, StoredEvent>>()
  const ackedByInvocation = new Map<string, number>()
  const floorByInvocation = new Map<string, number>()

  if (path !== undefined) {
    mkdirSync(dirname(path), { recursive: true })
    loadExisting(path, eventsByInvocation)
  }

  function appendSync(event: InvocationEventEnvelope): EventLedgerAppendResult {
    const invocationId = event.invocationId
    const seq = event.seq
    const bytes = stableJsonStringify(event)
    const bySeq = eventsByInvocation.get(invocationId) ?? new Map<number, StoredEvent>()
    const existing = bySeq.get(seq)
    if (existing !== undefined) {
      if (existing.bytes !== bytes) {
        throw new BrokerError(
          BrokerErrorCode.ResourceError,
          `Conflicting duplicate event for ${invocationId} seq ${seq}`,
          { invocationId, seq }
        )
      }
      return { appended: false }
    }

    bySeq.set(seq, { event: structuredClone(event), bytes })
    eventsByInvocation.set(invocationId, bySeq)
    if (path !== undefined) {
      appendLine(path, `${bytes}\n`)
    }
    return { appended: true }
  }

  return {
    append(event: InvocationEventEnvelope): Promise<EventLedgerAppendResult> {
      try {
        return Promise.resolve(appendSync(event))
      } catch (error) {
        return Promise.reject(error)
      }
    },

    eventsSince(invocationId: InvocationId, afterSeq: number): Promise<InvocationEventEnvelope[]> {
      const floor = floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR
      if (afterSeq < floor) {
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.EventReplayUnavailable,
            `Event replay unavailable before retention floor ${floor}`,
            { invocationId, afterSeq, retentionFloorSeq: floor }
          )
        )
      }
      const bySeq = eventsByInvocation.get(invocationId) ?? new Map<number, StoredEvent>()
      const events = [...bySeq.entries()]
        .filter(([seq]) => seq > afterSeq)
        .sort(([left], [right]) => left - right)
        .map(([, stored]) => structuredClone(stored.event))
      return Promise.resolve(events)
    },

    ackEvents(invocationId: InvocationId, throughSeq: number): Promise<EventLedgerAckResult> {
      const previous = ackedByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR
      if (throughSeq < previous) {
        return Promise.reject(
          new BrokerError(
            BrokerErrorCode.EventReplayUnavailable,
            `Event ack cannot move backwards from ${previous} to ${throughSeq}`,
            { invocationId, previousAckedThroughSeq: previous, throughSeq }
          )
        )
      }
      ackedByInvocation.set(invocationId, throughSeq)
      return Promise.resolve({ ackedThroughSeq: throughSeq })
    },

    retentionFloorSeq(invocationId: InvocationId): Promise<number> {
      return Promise.resolve(floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR)
    },

    currentSeq(invocationId: InvocationId): number {
      const bySeq = eventsByInvocation.get(invocationId)
      if (bySeq === undefined || bySeq.size === 0) {
        return 0
      }
      return Math.max(...bySeq.keys())
    },

    prune(options: EventLedgerPruneOptions): Promise<void> {
      const active = new Set(options.activeInvocationIds)
      for (const [invocationId, ackedThroughSeq] of ackedByInvocation.entries()) {
        if (active.has(invocationId)) {
          continue
        }
        const currentFloor = floorByInvocation.get(invocationId) ?? DEFAULT_RETENTION_FLOOR
        if (ackedThroughSeq <= currentFloor) {
          continue
        }
        floorByInvocation.set(invocationId, ackedThroughSeq)
        const bySeq = eventsByInvocation.get(invocationId)
        if (bySeq !== undefined) {
          for (const seq of bySeq.keys()) {
            if (seq <= ackedThroughSeq) {
              bySeq.delete(seq)
            }
          }
        }
      }
      if (path !== undefined) {
        rewriteLedger(path, eventsByInvocation)
      }
      return Promise.resolve()
    },
  }
}

function loadExisting(
  path: string,
  eventsByInvocation: Map<string, Map<number, StoredEvent>>
): void {
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return
  }
  for (const line of raw.split('\n')) {
    if (line.trim() === '') {
      continue
    }
    const parsed = JSON.parse(line) as InvocationEventEnvelope
    const bytes = stableJsonStringify(parsed)
    const bySeq = eventsByInvocation.get(parsed.invocationId) ?? new Map<number, StoredEvent>()
    bySeq.set(parsed.seq, { event: parsed, bytes })
    eventsByInvocation.set(parsed.invocationId, bySeq)
  }
}

function appendLine(path: string, line: string): void {
  const fd = openSync(path, 'a')
  try {
    writeFileSync(fd, line)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function rewriteLedger(
  path: string,
  eventsByInvocation: Map<string, Map<number, StoredEvent>>
): void {
  const tmp = `${path}.tmp`
  const rows = [...eventsByInvocation.values()]
    .flatMap((bySeq) => [...bySeq.values()])
    .sort((left, right) => {
      const invocationOrder = left.event.invocationId.localeCompare(right.event.invocationId)
      return invocationOrder === 0 ? left.event.seq - right.event.seq : invocationOrder
    })
    .map((stored) => stored.bytes)
  writeFileSync(tmp, rows.length === 0 ? '' : `${rows.join('\n')}\n`)
  const fd = openSync(tmp, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJson(value))
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJson(item))
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(record).sort()) {
      const item = record[key]
      if (item !== undefined) {
        sorted[key] = sortJson(item)
      }
    }
    return sorted
  }
  return value
}
