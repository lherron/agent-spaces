import type { EventFamily } from 'spaces-harness-broker-protocol'
import type { NormalizeOutcome } from '../../capture/capture-gate'
import {
  CODEX_ITEM_CARRYING_EVENT_MSG_TYPES,
  CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES,
  CODEX_KNOWN_ROLLOUT_ITEM_TYPES,
  CODEX_KNOWN_ROLLOUT_RESPONSE_ITEM_TYPES,
  CODEX_KNOWN_ROLLOUT_ROW_TYPES,
  CODEX_UNKNOWN_ITEM_FAMILY,
  CODEX_UNKNOWN_ROLLOUT_FAMILY,
} from '../codex-cli-tmux/native-types'
import { getString } from '../hook-json'

export {
  CODEX_ITEM_CARRYING_EVENT_MSG_TYPES,
  CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES,
  CODEX_KNOWN_ROLLOUT_ITEM_TYPES,
  CODEX_KNOWN_ROLLOUT_RESPONSE_ITEM_TYPES,
  CODEX_KNOWN_ROLLOUT_ROW_TYPES,
  CODEX_UNKNOWN_ITEM_FAMILY,
  CODEX_UNKNOWN_ROLLOUT_FAMILY,
} from '../codex-cli-tmux/native-types'

export function asCodexRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

export function parseCodexRolloutLine(line: string): Record<string, unknown> | undefined {
  try {
    return asCodexRecord(JSON.parse(line) as unknown)
  } catch {
    return undefined
  }
}

/** Three-level native identity shared by hook and desktop capture. */
export function codexNativeTypeOf(line: string): string {
  const entry = parseCodexRolloutLine(line)
  if (entry === undefined) return line.trim().length === 0 ? 'blank' : 'unparsable'
  const rowType = getString(entry, 'type') ?? 'untyped'
  const payload = asCodexRecord(entry['payload'])
  if (payload === undefined) return rowType
  if (rowType === 'response_item') {
    return `response_item:${getString(payload, 'type') ?? '(none)'}`
  }
  if (rowType !== 'event_msg') return rowType
  const payloadType = getString(payload, 'type') ?? '(none)'
  if (!CODEX_ITEM_CARRYING_EVENT_MSG_TYPES.has(payloadType)) {
    return `event_msg:${payloadType}`
  }
  const item = asCodexRecord(payload['item'])
  return `event_msg:${payloadType}:${item === undefined ? '(none)' : (getString(item, 'type') ?? '(none)')}`
}

export type ClassifiedCodexRollout =
  | { outcome: NormalizeOutcome }
  | {
      entry: Record<string, unknown>
      payload: Record<string, unknown>
      payloadType: string
      item?: Record<string, unknown> | undefined
    }

/** Shared pinned-vocabulary classification; semantics stay caller-specific. */
export function classifyCodexRolloutLine(line: string): ClassifiedCodexRollout {
  if (line.trim().length === 0) {
    return { outcome: { disposition: 'ignored-known', detail: 'blank line' } }
  }
  const entry = parseCodexRolloutLine(line)
  if (entry === undefined) {
    return { outcome: { disposition: 'ignored-known', detail: 'unparsable row' } }
  }
  const rowType = getString(entry, 'type') ?? '(none)'
  if (!CODEX_KNOWN_ROLLOUT_ROW_TYPES.has(rowType)) {
    return unknown(CODEX_UNKNOWN_ROLLOUT_FAMILY, `Unknown Codex rollout row type: ${rowType}`)
  }
  const payload = asCodexRecord(entry['payload'])
  if (rowType === 'response_item') {
    const itemType = payload === undefined ? undefined : getString(payload, 'type')
    if (itemType === undefined || !CODEX_KNOWN_ROLLOUT_RESPONSE_ITEM_TYPES.has(itemType)) {
      return unknown(
        CODEX_UNKNOWN_ROLLOUT_FAMILY,
        `Unknown Codex rollout response_item type: ${itemType ?? '(none)'}`
      )
    }
    return { outcome: { disposition: 'ignored-known', detail: `response_item:${itemType}` } }
  }
  if (rowType !== 'event_msg') {
    return { outcome: { disposition: 'ignored-known', detail: rowType } }
  }
  if (payload === undefined) {
    return { outcome: { disposition: 'ignored-known', detail: 'event_msg with no payload object' } }
  }
  const payloadType = getString(payload, 'type')
  if (payloadType === undefined || !CODEX_KNOWN_ROLLOUT_EVENT_MSG_TYPES.has(payloadType)) {
    return unknown(
      CODEX_UNKNOWN_ROLLOUT_FAMILY,
      `Unknown Codex rollout event_msg type: ${payloadType ?? '(none)'}`
    )
  }
  let item: Record<string, unknown> | undefined
  if (CODEX_ITEM_CARRYING_EVENT_MSG_TYPES.has(payloadType)) {
    item = asCodexRecord(payload['item'])
    const itemType = item === undefined ? undefined : getString(item, 'type')
    if (itemType === undefined || !CODEX_KNOWN_ROLLOUT_ITEM_TYPES.has(itemType)) {
      return unknown(
        CODEX_UNKNOWN_ITEM_FAMILY,
        `Unknown Codex rollout item type: ${payloadType}/${itemType ?? '(none)'}`
      )
    }
  }
  return { entry, payload, payloadType, ...(item !== undefined ? { item } : {}) }
}

function unknown(family: EventFamily, message: string): ClassifiedCodexRollout {
  return { outcome: { disposition: 'blocked-unknown', family, message } }
}

export function codexContentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .flatMap((part) => {
      const record = asCodexRecord(part)
      const text = record === undefined ? undefined : getString(record, 'text')
      return text === undefined ? [] : [text]
    })
    .join('')
}
