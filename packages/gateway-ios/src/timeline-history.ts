import type { HrcLifecycleEvent, HrcMessageFilter, HrcMessageRecord } from 'hrc-core'
import { normalizeSessionRef, splitSessionRef } from 'hrc-core'
import type { HrcClient } from 'hrc-sdk'

import type { HistoryPage } from './contracts.js'
import { projectTimeline } from './frame-projector.js'
import type { ReducerInput } from './types.js'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const INITIAL_BEFORE_HRC_SEQ = Number.MAX_SAFE_INTEGER

export type TimelineHistoryClient = Pick<HrcClient, 'watch' | 'listMessages'>

type ParsedHistoryQuery = {
  sessionRef: string
  scopeRef: string
  laneRef: string
  beforeHrcSeq?: number | undefined
  beforeMessageSeq?: number | undefined
  limit: number
  raw: boolean
}

class HistoryRequestError extends Error {
  readonly detail: Record<string, unknown> | undefined

  constructor(message: string, detail?: Record<string, unknown> | undefined) {
    super(message)
    this.name = 'HistoryRequestError'
    this.detail = detail
  }
}

function badRequest(message: string, detail?: Record<string, unknown>): never {
  throw new HistoryRequestError(message, detail)
}

function parseNonNegativeInt(raw: string | null, field: string): number | undefined {
  if (raw === null || raw.trim().length === 0) return undefined

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 0) {
    badRequest(`${field} must be a non-negative integer`, { field })
  }
  return parsed
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw.trim().length === 0) return DEFAULT_LIMIT

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    badRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`, { field: 'limit' })
  }
  return parsed
}

function parseBool(raw: string | null, field: string): boolean {
  if (raw === null || raw.trim().length === 0) return false

  switch (raw.trim().toLowerCase()) {
    case 'true':
    case '1':
      return true
    case 'false':
    case '0':
      return false
    default:
      badRequest(`${field} must be a boolean`, { field })
  }
}

export function parseHistoryQuery(url: URL): ParsedHistoryQuery {
  const sessionRefRaw = url.searchParams.get('sessionRef')
  if (sessionRefRaw === null || sessionRefRaw.trim().length === 0) {
    badRequest('sessionRef is required', { field: 'sessionRef' })
  }

  let sessionRef: string
  let scopeRef: string
  let laneRef: string
  try {
    sessionRef = normalizeSessionRef(sessionRefRaw)
    const parts = splitSessionRef(sessionRef)
    scopeRef = parts.scopeRef
    laneRef = parts.laneRef
  } catch (cause) {
    badRequest('sessionRef must be a canonical sessionRef', {
      field: 'sessionRef',
      message: cause instanceof Error ? cause.message : String(cause),
    })
  }

  return {
    sessionRef,
    scopeRef,
    laneRef,
    beforeHrcSeq: parseNonNegativeInt(url.searchParams.get('beforeHrcSeq'), 'beforeHrcSeq'),
    beforeMessageSeq: parseNonNegativeInt(
      url.searchParams.get('beforeMessageSeq'),
      'beforeMessageSeq'
    ),
    limit: parseLimit(url.searchParams.get('limit')),
    raw: parseBool(url.searchParams.get('raw'), 'raw'),
  }
}

async function collectAsync<T>(source: AsyncIterable<T>): Promise<T[]> {
  const records: T[] = []
  for await (const record of source) {
    records.push(record)
  }
  return records
}

function eventMatchesSession(event: HrcLifecycleEvent, query: ParsedHistoryQuery): boolean {
  return event.scopeRef === query.scopeRef && event.laneRef === query.laneRef
}

async function collectSessionEventsBefore(
  hrcClient: TimelineHistoryClient,
  query: ParsedHistoryQuery,
  limit: number,
  beforeHrcSeq = query.beforeHrcSeq
): Promise<HrcLifecycleEvent[]> {
  if (limit <= 0 || beforeHrcSeq === 0) return []

  const batch = await collectAsync(
    hrcClient.watch({ beforeHrcSeq: beforeHrcSeq ?? INITIAL_BEFORE_HRC_SEQ, limit })
  )
  return batch.filter((event) => eventMatchesSession(event, query)).slice(0, limit)
}

async function collectSessionMessagesBefore(
  hrcClient: TimelineHistoryClient,
  query: ParsedHistoryQuery,
  limit: number,
  beforeMessageSeq = query.beforeMessageSeq
): Promise<HrcMessageRecord[]> {
  if (limit <= 0 || beforeMessageSeq === 0) return []

  const filter: HrcMessageFilter = {
    sessionRef: query.sessionRef,
    order: 'desc',
    limit,
    ...(beforeMessageSeq !== undefined ? { beforeSeq: beforeMessageSeq } : {}),
  }
  const response = await hrcClient.listMessages(filter)
  return response.messages
}

function inputTimestamp(input: ReducerInput): string {
  return input.kind === 'event' ? input.event.ts : input.message.createdAt
}

function sortChronological(a: ReducerInput, b: ReducerInput): number {
  const byTime = inputTimestamp(a).localeCompare(inputTimestamp(b))
  if (byTime !== 0) return byTime

  const aSeq = a.kind === 'event' ? a.event.hrcSeq : a.message.messageSeq
  const bSeq = b.kind === 'event' ? b.event.hrcSeq : b.message.messageSeq
  return aSeq - bSeq
}

function buildCursor(
  events: HrcLifecycleEvent[],
  messages: HrcMessageRecord[]
): {
  oldestCursor: HistoryPage['oldestCursor']
  newestCursor: HistoryPage['newestCursor']
} {
  const hrcSeqs = events.map((event) => event.hrcSeq)
  const messageSeqs = messages.map((message) => message.messageSeq)

  return {
    oldestCursor: {
      hrcSeq: hrcSeqs.length > 0 ? Math.min(...hrcSeqs) : 0,
      messageSeq: messageSeqs.length > 0 ? Math.min(...messageSeqs) : 0,
    },
    newestCursor: {
      hrcSeq: hrcSeqs.length > 0 ? Math.max(...hrcSeqs) : 0,
      messageSeq: messageSeqs.length > 0 ? Math.max(...messageSeqs) : 0,
    },
  }
}

async function hasMoreBefore(
  hrcClient: TimelineHistoryClient,
  query: ParsedHistoryQuery,
  oldestCursor: HistoryPage['oldestCursor']
): Promise<boolean> {
  const olderEvents =
    oldestCursor.hrcSeq > 0
      ? await collectSessionEventsBefore(hrcClient, query, 1, oldestCursor.hrcSeq)
      : []
  if (olderEvents.length > 0) return true

  const olderMessages =
    oldestCursor.messageSeq > 0
      ? await collectSessionMessagesBefore(hrcClient, query, 1, oldestCursor.messageSeq)
      : []
  return olderMessages.length > 0
}

/**
 * Project a window of past events/messages for a given session into a HistoryPage.
 *
 * Shared by both the GET /v1/history endpoint and the WS /v1/timeline snapshot
 * builder. Queries events (before beforeHrcSeq) and messages (before
 * beforeMessageSeq) from the HRC store, filters by session, projects through
 * the reducer, and returns frames in chronological order with cursors.
 */
export async function projectPastWindow(
  hrcClient: TimelineHistoryClient,
  opts: {
    sessionRef: string
    beforeHrcSeq?: number | undefined
    beforeMessageSeq?: number | undefined
    limit: number
  }
): Promise<HistoryPage> {
  const sessionRef = normalizeSessionRef(opts.sessionRef)
  const parts = splitSessionRef(sessionRef)
  const query: ParsedHistoryQuery = {
    sessionRef,
    scopeRef: parts.scopeRef,
    laneRef: parts.laneRef,
    beforeHrcSeq: opts.beforeHrcSeq,
    beforeMessageSeq: opts.beforeMessageSeq,
    limit: opts.limit,
    raw: false,
  }

  const [eventsDescending, messagesDescending] = await Promise.all([
    collectSessionEventsBefore(hrcClient, query, query.limit),
    collectSessionMessagesBefore(hrcClient, query, query.limit),
  ])

  const events = [...eventsDescending].reverse()
  const messages = [...messagesDescending].reverse()
  const inputs: ReducerInput[] = [
    ...events.map((event) => ({ kind: 'event' as const, event })),
    ...messages.map((message) => ({ kind: 'message' as const, message })),
  ].sort(sortChronological)

  const { frames } = projectTimeline(inputs)
  const { oldestCursor, newestCursor } = buildCursor(events, messages)

  return {
    frames,
    oldestCursor,
    newestCursor,
    hasMoreBefore: await hasMoreBefore(hrcClient, query, oldestCursor),
  }
}

export async function getTimelineHistoryPage(
  hrcClient: TimelineHistoryClient,
  url: URL
): Promise<HistoryPage> {
  const query = parseHistoryQuery(url)
  void query.raw

  return projectPastWindow(hrcClient, {
    sessionRef: query.sessionRef,
    beforeHrcSeq: query.beforeHrcSeq,
    beforeMessageSeq: query.beforeMessageSeq,
    limit: query.limit,
  })
}

export async function handleHistoryRequest(
  request: Request,
  options: { hrcClient: TimelineHistoryClient }
): Promise<Response> {
  try {
    const page = await getTimelineHistoryPage(options.hrcClient, new URL(request.url))
    return Response.json(page)
  } catch (error) {
    if (error instanceof HistoryRequestError) {
      return Response.json(
        {
          error: {
            code: 'bad_request',
            message: error.message,
            detail: error.detail ?? {},
          },
        },
        { status: 400 }
      )
    }
    throw error
  }
}
