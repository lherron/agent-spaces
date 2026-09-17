import { Database } from 'bun:sqlite'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import type {
  AspReleaseIdentity,
  InvocationEventEnvelope,
  InvocationEventType,
  InvocationId,
  OfflineArtifactSnapshot,
  OfflineEvidenceErrorCode,
  OfflineEvidenceRequest,
  OfflineEvidenceResponse,
  OfflineFileIdentity,
  OfflineLedgerSnapshot,
} from 'spaces-harness-broker-protocol'
import { INVOCATION_EVENT_TYPES, OFFLINE_EVIDENCE_SCHEMA } from 'spaces-harness-broker-protocol'
import { brokerComparisonForms, parseProviderPage } from './offline-provider-comparison'

const DEFAULT_LIMIT = 500
const MAX_LIMIT = 1000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024
const MIN_MAX_BYTES = 64 * 1024
const MAX_MAX_BYTES = 8 * 1024 * 1024
const KNOWN_EVENT_TYPES: ReadonlySet<string> = new Set(INVOCATION_EVENT_TYPES)
const COMPARABLE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'user.message',
  'assistant.message.completed',
  'tool.call.started',
  'tool.call.completed',
  'tool.call.failed',
])

export async function runOfflineEvidenceCli(
  args: string[],
  release: AspReleaseIdentity | undefined
): Promise<void> {
  const raw = await new Response(process.stdin).text()
  let candidate: unknown
  try {
    candidate = JSON.parse(raw)
  } catch {
    return writeFailure(
      undefined,
      release,
      'invalid_request',
      'stdin must contain exactly one JSON request'
    )
  }
  const operation = operationOf(candidate)
  if (release === undefined) {
    return writeFailure(
      operation,
      undefined,
      'offline_schema_unsupported',
      'checkout executable has no immutable release identity'
    )
  }

  let request: OfflineEvidenceRequest
  try {
    request = validateRequest(candidate, Buffer.byteLength(raw))
  } catch (error) {
    const failure =
      error instanceof OfflineFailure
        ? error
        : new OfflineFailure('invalid_request', describe(error))
    return writeFailure(operation, release, failure.code, failure.message, failure.data)
  }

  try {
    const response =
      request.operation === 'eventsSince'
        ? readEvents(request, args, release)
        : readProviderObservations(request, args, release)
    writeResponse(response, 0)
  } catch (error) {
    if (!(error instanceof OfflineFailure)) throw error
    writeFailure(request.operation, release, error.code, error.message, error.data)
  }
}

class OfflineFailure extends Error {
  constructor(
    readonly code: OfflineEvidenceErrorCode,
    message: string,
    readonly data?: Record<string, unknown>
  ) {
    super(message)
  }
}

function validateRequest(value: unknown, inputBytes: number): OfflineEvidenceRequest {
  if (!isRecord(value) || value['schema'] !== OFFLINE_EVIDENCE_SCHEMA) {
    throw new OfflineFailure('invalid_request', 'unsupported or missing request schema')
  }
  const operation = value['operation']
  if (inputBytes > MAX_MAX_BYTES && operation !== 'providerObservations') {
    invalid('request exceeds the 8 MiB input cap')
  }
  if (operation === 'eventsSince') {
    assertClosed(value, [
      'schema',
      'operation',
      'invocationId',
      'afterSeq',
      'types',
      'limit',
      'maxBytes',
    ])
    if (typeof value['invocationId'] !== 'string' || value['invocationId'].length === 0)
      invalid('invocationId must be non-empty')
    assertNonNegativeInteger(value['afterSeq'], 'afterSeq')
    const limit = boundedInteger(value['limit'], 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)
    const maxBytes = boundedInteger(
      value['maxBytes'],
      'maxBytes',
      DEFAULT_MAX_BYTES,
      MIN_MAX_BYTES,
      MAX_MAX_BYTES
    )
    if (
      value['types'] !== undefined &&
      (!Array.isArray(value['types']) ||
        value['types'].some((item) => typeof item !== 'string' || !KNOWN_EVENT_TYPES.has(item)))
    ) {
      invalid('types must be an array of supported event names')
    }
    return {
      schema: OFFLINE_EVIDENCE_SCHEMA,
      operation,
      invocationId: value['invocationId'] as never,
      afterSeq: value['afterSeq'] as number,
      ...(value['types'] !== undefined ? { types: value['types'] as InvocationEventType[] } : {}),
      limit,
      maxBytes,
    }
  }
  if (operation === 'providerObservations') {
    assertClosed(value, [
      'schema',
      'operation',
      'artifactPath',
      'providerHint',
      'afterLine',
      'limit',
      'maxBytes',
      'brokerEvents',
      'snapshot',
    ])
    if (typeof value['artifactPath'] !== 'string' || value['artifactPath'].length === 0)
      invalid('artifactPath must be non-empty')
    assertNonNegativeInteger(value['afterLine'], 'afterLine')
    const limit = boundedInteger(value['limit'], 'limit', DEFAULT_LIMIT, 1, MAX_LIMIT)
    const maxBytes = boundedInteger(
      value['maxBytes'],
      'maxBytes',
      DEFAULT_MAX_BYTES,
      MIN_MAX_BYTES,
      MAX_MAX_BYTES
    )
    if (!Array.isArray(value['brokerEvents']) || value['brokerEvents'].length > MAX_LIMIT) {
      invalid('brokerEvents must contain at most 1000 rows')
    }
    let priorSeq = 0
    let invocationId: string | undefined
    for (const event of value['brokerEvents']) {
      if (!validEvent(event) || event.seq <= priorSeq) {
        invalid('brokerEvents must be valid comparable envelopes in strictly ascending seq order')
      }
      if (invocationId !== undefined && event.invocationId !== invocationId) {
        invalid('brokerEvents must belong to one invocation')
      }
      if (!COMPARABLE_EVENT_TYPES.has(event.type)) {
        invalid(`non-comparable broker event type: ${event.type}`)
      }
      invocationId = event.invocationId
      priorSeq = event.seq
    }
    if (
      value['providerHint'] !== undefined &&
      value['providerHint'] !== 'codex' &&
      value['providerHint'] !== 'claude-code'
    )
      invalid('invalid providerHint')
    if ((value['afterLine'] as number) === 0 && value['snapshot'] !== undefined)
      invalid('snapshot must be absent on the first page')
    if ((value['afterLine'] as number) > 0 && !validIdentity(value['snapshot']))
      invalid('snapshot is required after the first page')
    if (inputBytes > MAX_MAX_BYTES) {
      const oversized = (value['brokerEvents'] as unknown[]).find(
        (event) => Buffer.byteLength(JSON.stringify(event)) > MAX_MAX_BYTES
      )
      const boundary = oversized ?? (value['brokerEvents'] as unknown[]).at(-1)
      const seq =
        isRecord(boundary) && typeof boundary['seq'] === 'number' ? boundary['seq'] : undefined
      throw new OfflineFailure('offline_record_too_large', 'request exceeds the 8 MiB input cap', {
        kind: 'broker_event',
        ...(seq !== undefined ? { seq } : {}),
        bytes: inputBytes,
        maxBytes: MAX_MAX_BYTES,
      })
    }
    return {
      schema: OFFLINE_EVIDENCE_SCHEMA,
      operation,
      artifactPath: value['artifactPath'],
      ...(value['providerHint'] !== undefined ? { providerHint: value['providerHint'] } : {}),
      afterLine: value['afterLine'] as number,
      limit,
      maxBytes,
      brokerEvents: value['brokerEvents'] as InvocationEventEnvelope[],
      ...(value['snapshot'] !== undefined
        ? { snapshot: value['snapshot'] as OfflineArtifactSnapshot }
        : {}),
    }
  }
  invalid('operation must be eventsSince or providerObservations')
}

function readEvents(
  request: Extract<OfflineEvidenceRequest, { operation: 'eventsSince' }>,
  args: string[],
  release: AspReleaseIdentity
): OfflineEvidenceResponse {
  validateReaderArgs(args, true)
  const ledgerPath = requiredFlag(args, '--event-ledger')
  const indexPath = requiredFlag(args, '--index')
  const ledgerBefore = fileIdentity(ledgerPath, 'ledger_unavailable')
  let bytes: Buffer
  try {
    bytes = readFileSync(ledgerPath)
  } catch (error) {
    throw new OfflineFailure('ledger_unavailable', `cannot read ledger: ${describe(error)}`)
  }
  const ledgerAfter = fileIdentity(ledgerPath, 'ledger_unavailable')
  if (!sameIdentity(ledgerBefore, ledgerAfter)) unstable('ledger changed while reading')

  const { state, identity: indexIdentity } = readIndexSnapshot(indexPath, request.invocationId)
  const parsed = parseLedger(bytes)
  const rows = parsed.events
    .filter((event) => event.invocationId === request.invocationId)
    .sort((left, right) => left.seq - right.seq)
  const currentSeq = Math.max(rows.at(-1)?.seq ?? 0, state.retentionFloorSeq)
  assertSnapshotUnchanged(ledgerPath, ledgerBefore, indexPath, indexIdentity)
  if (request.afterSeq < state.retentionFloorSeq) {
    throw new OfflineFailure('replay_below_floor', 'requested cursor is below retention floor', {
      invocationId: request.invocationId,
      afterSeq: request.afterSeq,
      retentionFloorSeq: state.retentionFloorSeq,
      currentSeq,
    })
  }

  const limit = request.limit ?? DEFAULT_LIMIT
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
  const types = request.types === undefined ? undefined : new Set(request.types)
  const candidates = rows.filter((event) => event.seq > request.afterSeq)
  const selected: InvocationEventEnvelope[] = []
  let nextAfterSeq = request.afterSeq
  let response = eventSuccess(
    release,
    selected,
    currentSeq,
    state.retentionFloorSeq,
    nextAfterSeq,
    candidates.length > 0,
    { ledger: ledgerBefore, index: indexIdentity },
    parsed.integrity
  )
  for (const [index, event] of candidates.entries()) {
    const included = types === undefined || types.has(event.type)
    if (included && selected.length >= limit) break
    const proposed = included ? [...selected, event] : selected
    const proposedResponse = eventSuccess(
      release,
      proposed,
      currentSeq,
      state.retentionFloorSeq,
      event.seq,
      index < candidates.length - 1,
      {
        ledger: ledgerBefore,
        index: indexIdentity,
      },
      parsed.integrity
    )
    if (encodedBytes(proposedResponse) > maxBytes) {
      if (included && selected.length === 0) {
        throw new OfflineFailure('offline_record_too_large', 'one event exceeds maxBytes', {
          kind: 'event',
          seq: event.seq,
          bytes: encodedBytes(proposedResponse),
          maxBytes,
        })
      }
      if (!included && selected.length === 0) {
        throw new OfflineFailure(
          'offline_record_too_large',
          'filtered cursor response exceeds maxBytes',
          {
            kind: 'filtered_cursor',
            seq: event.seq,
            bytes: encodedBytes(proposedResponse),
            maxBytes,
          }
        )
      }
      break
    }
    if (included) selected.push(event)
    nextAfterSeq = event.seq
    response = proposedResponse
  }
  return response
}

function eventSuccess(
  release: AspReleaseIdentity,
  events: InvocationEventEnvelope[],
  currentSeq: number,
  retentionFloorSeq: number,
  nextAfterSeq: number,
  hasMore: boolean,
  snapshot: OfflineLedgerSnapshot,
  integrity: Extract<OfflineEvidenceResponse, { operation: 'eventsSince'; ok: true }>['integrity']
): Extract<OfflineEvidenceResponse, { operation: 'eventsSince'; ok: true }> {
  return {
    schema: OFFLINE_EVIDENCE_SCHEMA,
    ok: true,
    operation: 'eventsSince',
    release,
    result: { events, currentSeq, retentionFloorSeq },
    hasMore,
    nextAfterSeq,
    snapshot,
    integrity,
  }
}

function readProviderObservations(
  request: Extract<OfflineEvidenceRequest, { operation: 'providerObservations' }>,
  args: string[],
  release: AspReleaseIdentity
): OfflineEvidenceResponse {
  validateReaderArgs(args, false)
  if (!existsSync(request.artifactPath)) {
    throw new OfflineFailure(
      'provider_artifact_not_found',
      `provider artifact not found: ${request.artifactPath}`
    )
  }
  const before = fileIdentity(request.artifactPath, 'provider_artifact_unreadable')
  if (request.snapshot !== undefined && !sameIdentity(request.snapshot, before)) {
    throw new OfflineFailure(
      'provider_artifact_snapshot_unstable',
      'provider artifact does not match prior page snapshot'
    )
  }
  let raw: string
  try {
    raw = readFileSync(request.artifactPath, 'utf8')
  } catch (error) {
    throw new OfflineFailure(
      'provider_artifact_unreadable',
      `cannot read provider artifact: ${describe(error)}`
    )
  }
  const after = fileIdentity(request.artifactPath, 'provider_artifact_unreadable')
  if (!sameIdentity(before, after)) {
    throw new OfflineFailure(
      'provider_artifact_snapshot_unstable',
      'provider artifact changed while reading'
    )
  }
  const lines = raw.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (request.afterLine > lines.length) invalid('afterLine exceeds the artifact')
  const comparisons = brokerComparisonForms(request.brokerEvents)
  const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES
  const responseFor = (
    throughLine: number,
    brokerComparisons = comparisons
  ): Extract<OfflineEvidenceResponse, { operation: 'providerObservations'; ok: true }> => {
    const parsed = parseProviderPage({ lines, afterLine: request.afterLine, throughLine })
    if (
      request.providerHint !== undefined &&
      parsed.provider !== 'unknown' &&
      parsed.provider !== request.providerHint
    ) {
      if (parsed.providerBeforePage !== parsed.provider) {
        parsed.warnings.push(
          `provider hint ${request.providerHint} did not match detected ${parsed.provider}`
        )
      }
      parsed.provider = 'unknown'
    }
    return {
      schema: OFFLINE_EVIDENCE_SCHEMA,
      ok: true,
      operation: 'providerObservations',
      release,
      snapshot: before,
      provider: parsed.provider,
      observations: parsed.observations,
      brokerComparisons,
      warnings: parsed.warnings,
      page: { scannedThroughLine: throughLine, hasMore: throughLine < lines.length },
      counts: parsed.counts,
    }
  }

  let response = responseFor(request.afterLine)
  if (encodedBytes(response) > maxBytes) {
    let comparisonPrefix: typeof comparisons = []
    for (const comparison of comparisons) {
      const candidate = responseFor(request.afterLine, [...comparisonPrefix, comparison])
      if (encodedBytes(candidate) > maxBytes) {
        throw new OfflineFailure(
          'offline_record_too_large',
          'broker comparison response exceeds maxBytes',
          {
            kind: 'broker_comparison',
            seq: comparison.seq,
            bytes: encodedBytes(candidate),
            maxBytes,
          }
        )
      }
      comparisonPrefix = [...comparisonPrefix, comparison]
    }
  }
  const maxThroughLine = Math.min(
    lines.length,
    request.afterLine + (request.limit ?? DEFAULT_LIMIT)
  )
  for (let throughLine = request.afterLine + 1; throughLine <= maxThroughLine; throughLine += 1) {
    const candidate = responseFor(throughLine)
    if (encodedBytes(candidate) <= maxBytes) {
      response = candidate
      continue
    }
    if (throughLine === request.afterLine + 1) {
      const observation = candidate.observations.at(-1)
      throw new OfflineFailure(
        'offline_record_too_large',
        'provider response item exceeds maxBytes',
        {
          kind: observation !== undefined ? 'observation' : 'warning',
          ...(observation !== undefined ? { line: observation.line } : { line: throughLine }),
          bytes: encodedBytes(candidate),
          maxBytes,
        }
      )
    }
    break
  }
  return response
}

function readIndexSnapshot(
  indexPath: string,
  invocationId: string
): {
  state: { ackedThroughSeq: number; retentionFloorSeq: number }
  identity: OfflineLedgerSnapshot['index']
} {
  const dbBefore = fileIdentity(indexPath, 'ledger_index_unavailable')
  const walPath = `${indexPath}-wal`
  const walBefore = existsSync(walPath)
    ? fileIdentity(walPath, 'ledger_index_unavailable')
    : undefined
  const temp = mkdtempSync(join(tmpdir(), 'harness-broker-offline-index-'))
  try {
    const dbCopy = join(temp, basename(indexPath))
    copyFileSync(indexPath, dbCopy)
    if (walBefore !== undefined) copyFileSync(walPath, `${dbCopy}-wal`)
    const dbAfter = fileIdentity(indexPath, 'ledger_index_unavailable')
    const walAfter = existsSync(walPath)
      ? fileIdentity(walPath, 'ledger_index_unavailable')
      : undefined
    if (!sameIdentity(dbBefore, dbAfter) || !sameOptionalIdentity(walBefore, walAfter)) {
      unstable('ledger index changed while copying')
    }
    const db = new Database(dbCopy)
    try {
      const row = db
        .query<{ acked_through_seq: number; retention_floor_seq: number }, [string]>(
          'SELECT acked_through_seq, retention_floor_seq FROM consumer_state WHERE invocation_id = ?'
        )
        .get(invocationId)
      if (
        row !== null &&
        row !== undefined &&
        (!Number.isSafeInteger(row.acked_through_seq) ||
          row.acked_through_seq < 0 ||
          !Number.isSafeInteger(row.retention_floor_seq) ||
          row.retention_floor_seq < 0 ||
          row.retention_floor_seq > row.acked_through_seq)
      ) {
        throw new OfflineFailure(
          'ledger_index_unavailable',
          'ledger index contains invalid consumer state'
        )
      }
      return {
        state: {
          ackedThroughSeq: row?.acked_through_seq ?? 0,
          retentionFloorSeq: row?.retention_floor_seq ?? 0,
        },
        identity: { db: dbBefore, ...(walBefore !== undefined ? { wal: walBefore } : {}) },
      }
    } finally {
      db.close()
    }
  } catch (error) {
    if (error instanceof OfflineFailure) throw error
    throw new OfflineFailure(
      'ledger_index_unavailable',
      `cannot read ledger index snapshot: ${describe(error)}`
    )
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function parseLedger(bytes: Buffer): {
  events: InvocationEventEnvelope[]
  integrity: Extract<OfflineEvidenceResponse, { operation: 'eventsSince'; ok: true }>['integrity']
} {
  const events: InvocationEventEnvelope[] = []
  const seen = new Map<string, { bytes: string; offset: number }>()
  let offset = 0
  let lastIntactByteOffset = 0
  let lastIntact: { invocationId: InvocationId; seq: number } | undefined
  while (offset < bytes.length) {
    const newline = bytes.indexOf(0x0a, offset)
    const terminated = newline !== -1
    const end = terminated ? newline : bytes.length
    const line = bytes.toString('utf8', offset, end)
    const next = terminated ? end + 1 : bytes.length
    if (line.trim() === '') {
      if (!terminated) break
      offset = next
      lastIntactByteOffset = next
      continue
    }
    let event: InvocationEventEnvelope | undefined
    try {
      const parsed = JSON.parse(line) as unknown
      if (validEvent(parsed)) event = parsed
    } catch {}
    if (event === undefined) {
      if (!terminated || next >= bytes.length) {
        return {
          events,
          integrity: {
            status: 'torn_tail',
            byteLength: bytes.length,
            lastIntactByteOffset,
            trailingBytes: bytes.length - lastIntactByteOffset,
            ...(lastIntact !== undefined ? { lastIntact } : {}),
          },
        }
      }
      throw new OfflineFailure('ledger_corrupt', 'unreadable interior ledger record', {
        byteOffset: offset,
        lastIntactByteOffset,
        ...(lastIntact !== undefined ? { lastIntact } : {}),
      })
    }
    const key = `${event.invocationId}\u0000${event.seq}`
    const prior = seen.get(key)
    if (prior !== undefined && prior.bytes !== line) {
      throw new OfflineFailure(
        'ledger_conflicting_duplicate',
        'conflicting duplicate ledger record',
        {
          invocationId: event.invocationId,
          seq: event.seq,
          firstByteOffset: prior.offset,
          duplicateByteOffset: offset,
        }
      )
    }
    if (prior === undefined) {
      seen.set(key, { bytes: line, offset })
      events.push(event)
    }
    lastIntact = { invocationId: event.invocationId, seq: event.seq }
    offset = next
    lastIntactByteOffset = next
  }
  return { events, integrity: { status: 'intact', byteLength: bytes.length } }
}

function validEvent(value: unknown): value is InvocationEventEnvelope {
  return (
    isRecord(value) &&
    typeof value['invocationId'] === 'string' &&
    value['invocationId'].length > 0 &&
    Number.isInteger(value['seq']) &&
    (value['seq'] as number) > 0 &&
    typeof value['time'] === 'string' &&
    typeof value['type'] === 'string' &&
    KNOWN_EVENT_TYPES.has(value['type']) &&
    Object.hasOwn(value, 'payload')
  )
}

function fileIdentity(path: string, code: OfflineEvidenceErrorCode): OfflineFileIdentity {
  try {
    return rawFileIdentity(path)
  } catch (error) {
    throw new OfflineFailure(code, `cannot stat ${path}: ${describe(error)}`)
  }
}

function rawFileIdentity(path: string): OfflineFileIdentity {
  const stat = statSync(path)
  if (!stat.isFile()) throw new Error('not a regular file')
  return { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs }
}

function sameIdentity(left: OfflineFileIdentity, right: OfflineFileIdentity): boolean {
  return left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs
}

function sameOptionalIdentity(
  left: OfflineFileIdentity | undefined,
  right: OfflineFileIdentity | undefined
): boolean {
  return left === undefined ? right === undefined : right !== undefined && sameIdentity(left, right)
}

function assertSnapshotUnchanged(
  ledgerPath: string,
  ledger: OfflineFileIdentity,
  indexPath: string,
  index: OfflineLedgerSnapshot['index']
): void {
  let currentLedger: OfflineFileIdentity
  let currentDb: OfflineFileIdentity
  let currentWal: OfflineFileIdentity | undefined
  try {
    currentLedger = rawFileIdentity(ledgerPath)
    currentDb = rawFileIdentity(indexPath)
    currentWal = existsSync(`${indexPath}-wal`) ? rawFileIdentity(`${indexPath}-wal`) : undefined
  } catch {
    unstable('ledger snapshot changed before the response was formed')
  }
  if (
    !sameIdentity(ledger, currentLedger) ||
    !sameIdentity(index.db, currentDb) ||
    !sameOptionalIdentity(index.wal, currentWal)
  ) {
    unstable('ledger snapshot changed before the response was formed')
  }
}

function validIdentity(value: unknown): value is OfflineArtifactSnapshot {
  return (
    isRecord(value) &&
    typeof value['ino'] === 'number' &&
    typeof value['size'] === 'number' &&
    typeof value['mtimeMs'] === 'number'
  )
}

function validateReaderArgs(args: string[], eventsOperation: boolean): void {
  if (!eventsOperation) {
    if (args.length !== 0) invalid('providerObservations accepts no command-line flags')
    return
  }
  const seen = new Set<string>()
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (
      (name !== '--event-ledger' && name !== '--index') ||
      value === undefined ||
      value.startsWith('--') ||
      seen.has(name)
    ) {
      invalid('eventsSince requires exactly one --event-ledger and one --index flag')
    }
    if (!isAbsolute(value)) invalid(`${name} must be an absolute path`)
    seen.add(name)
  }
  if (args.length !== 4 || !seen.has('--event-ledger') || !seen.has('--index')) {
    invalid('eventsSince requires exactly one --event-ledger and one --index flag')
  }
}

function operationOf(value: unknown): 'eventsSince' | 'providerObservations' | undefined {
  return isRecord(value) &&
    (value['operation'] === 'eventsSince' || value['operation'] === 'providerObservations')
    ? value['operation']
    : undefined
}

function requiredFlag(args: string[], name: string): string {
  const index = args.indexOf(name)
  const value = index === -1 ? undefined : args[index + 1]
  if (value === undefined || value.startsWith('--')) invalid(`missing ${name}`)
  return value
}

function assertClosed(value: Record<string, unknown>, allowed: string[]): void {
  const accepted = new Set(allowed)
  const extra = Object.keys(value).find((key) => !accepted.has(key))
  if (extra !== undefined) invalid(`unknown request property: ${extra}`)
}

function boundedInteger(
  value: unknown,
  name: string,
  fallback: number,
  min: number,
  max: number
): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || (value as number) < min || (value as number) > max)
    invalid(`${name} must be an integer in ${min}..${max}`)
  return value as number
}

function assertNonNegativeInteger(value: unknown, name: string): void {
  if (!Number.isInteger(value) || (value as number) < 0)
    invalid(`${name} must be a non-negative integer`)
}

function invalid(message: string): never {
  throw new OfflineFailure('invalid_request', message)
}

function unstable(message: string): never {
  throw new OfflineFailure('ledger_snapshot_unstable', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`)
}

function writeFailure(
  operation: 'eventsSince' | 'providerObservations' | undefined,
  release: AspReleaseIdentity | undefined,
  code: OfflineEvidenceErrorCode,
  message: string,
  data?: Record<string, unknown>
): void {
  const response: OfflineEvidenceResponse = {
    schema: OFFLINE_EVIDENCE_SCHEMA,
    ok: false,
    ...(operation !== undefined ? { operation } : {}),
    ...(release !== undefined ? { release } : {}),
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  }
  writeResponse(response, 2)
}

function writeResponse(response: OfflineEvidenceResponse, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(response)}\n`)
  process.exitCode = exitCode
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
