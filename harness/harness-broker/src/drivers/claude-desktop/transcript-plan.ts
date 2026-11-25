import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { RawProviderRecord } from 'spaces-harness-broker-protocol'
import type { CaptureGate } from '../../capture/capture-gate'
import { asRecord, getString } from '../hook-json'

export const CLAUDE_DESKTOP_DRIVER_KIND = 'claude-desktop'
export const CLAUDE_DESKTOP_DRIVER_VERSION = '0.2.0'

/**
 * Where the transcript replay turns from rebuilding state into publishing
 * events. Every row is normalized in file order from byte zero, so the shared
 * Claude state machines (turn attribution, held assistant prose, tool names)
 * always reach the same state for the same bytes. Rows before `liveFromByte`
 * only move that state; rows at or past it are committed and published.
 */
export interface ClaudeDesktopReplayPlan {
  mode: 'first-join' | 'resume' | 'resume-cursor'
  liveFromByte: number
  /**
   * Rows the previous broker committed but never dispositioned (it died
   * between the raw commit and the normalized commit). They are published
   * again without a second commit.
   */
  pendingOffsets: ReadonlySet<number>
  /** The previous broker's journaled rows by byte offset, for truthful provenance. */
  journaled: ReadonlyMap<number, RawProviderRecord>
}

/** Claude's project-dir name for a cwd: every non-alphanumeric byte becomes `-`. */
export function claudeProjectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/**
 * The session transcript: `<claudeHome>/projects/<cwd-dir>/<sessionId>.jsonl`,
 * else whichever project dir holds `<sessionId>.jsonl` (Claude shortens very
 * long cwd names). Undefined until Claude has written the file.
 */
export function locateClaudeTranscript(
  claudeHome: string,
  sessionId: string,
  cwd: string | undefined
): string | undefined {
  const projects = join(claudeHome, 'projects')
  const file = `${sessionId}.jsonl`
  if (cwd !== undefined) {
    const direct = join(projects, claudeProjectDirName(cwd), file)
    if (existsSync(direct)) return direct
  }
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = join(projects, dir, file)
      if (existsSync(candidate)) return candidate
    }
  } catch {
    return undefined
  }
  return undefined
}

/** A user row that opens a turn. Claude ≥ 2.1.3xx stamps `turnOrigin` on exactly these. */
export function isTurnOpenerRow(entry: Record<string, unknown> | undefined): boolean {
  return (
    entry !== undefined &&
    entry['type'] === 'user' &&
    typeof entry['turnOrigin'] === 'string' &&
    entry['turnCompanion'] !== true
  )
}

/** The `system` row Claude writes after a turn's Stop hooks; desktop sessions always have one. */
export function isTurnTerminalRow(entry: Record<string, unknown> | undefined): boolean {
  if (entry === undefined || entry['type'] !== 'system') return false
  const subtype = getString(entry, 'subtype')
  return subtype === 'stop_hook_summary' || subtype === 'turn_duration'
}

function isInterruptRow(entry: Record<string, unknown>): boolean {
  if (entry['type'] !== 'user') return false
  const content = asRecord(entry['message'])['content']
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((part) => getString(asRecord(part), 'text') ?? '').join('')
        : ''
  return text.trim().startsWith('[Request interrupted by user')
}

export function parseRow(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * First join of a session that already has history: publish from the row that
 * opened a still-open turn (the joiner is usually spawned by that turn's own
 * UserPromptSubmit), else from the end of the last complete row. Earlier turns
 * belong to no runtime and are not replayed into HRC.
 */
export function firstJoinBoundary(path: string): number {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return 0
  }
  let start = 0
  let openerOffset: number | undefined
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue
    const entry = parseRow(bytes.subarray(start, index).toString('utf8'))
    if (entry !== undefined) {
      if (isTurnOpenerRow(entry)) openerOffset = start
      else if (isTurnTerminalRow(entry) || isInterruptRow(entry)) openerOffset = undefined
    }
    start = index + 1
  }
  return openerOffset ?? start
}

/**
 * Where the last broker for this session stopped publishing, kept beside the
 * session's ledger. HRC mints a new invocation for every broker life, and the
 * capture journal is per invocation, so this is what carries the boundary
 * from one broker to the next.
 */
export interface ClaudeDesktopCursor {
  v: 1
  transcriptPath: string
  /** The next unread byte: just past the last published row's newline. */
  byteOffset: number
  /** Base64 of up to 64 bytes ending at `byteOffset`, to detect a replaced file. */
  anchor: string
}

const CURSOR_FILE = 'claude-desktop-cursor.json'
const ANCHOR_BYTES = 64

export function readClaudeDesktopCursor(stateDir: string): ClaudeDesktopCursor | undefined {
  const parsed = parseRow(safeRead(join(stateDir, CURSOR_FILE)) ?? '')
  return isClaudeDesktopCursor(parsed) ? parsed : undefined
}

function isClaudeDesktopCursor(
  parsed: Record<string, unknown> | undefined
): parsed is Record<string, unknown> & ClaudeDesktopCursor {
  return (
    parsed?.['v'] === 1 &&
    typeof parsed['transcriptPath'] === 'string' &&
    typeof parsed['byteOffset'] === 'number' &&
    typeof parsed['anchor'] === 'string'
  )
}

/** Record the boundary after a published row; tmp + rename so a crash leaves the old one. */
export function writeClaudeDesktopCursor(
  stateDir: string,
  transcriptPath: string,
  byteOffset: number
): void {
  const anchor = bytesBefore(transcriptPath, byteOffset)
  if (anchor === undefined) return
  const cursor: ClaudeDesktopCursor = {
    v: 1,
    transcriptPath,
    byteOffset,
    anchor: anchor.toString('base64'),
  }
  const path = join(stateDir, CURSOR_FILE)
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(cursor)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * Choose where publishing resumes. In order: the rows this same invocation
 * journaled (exact, including rows committed but never dispositioned); the
 * session cursor a previous broker life left; a first join. A boundary is
 * used only while the file still holds the bytes it was taken against.
 */
export function planClaudeDesktopReplay(
  capture: CaptureGate | undefined,
  path: string,
  stateDir?: string | undefined
): ClaudeDesktopReplayPlan {
  const records = (capture?.records() ?? []).filter(
    (record) =>
      record.driverKind === CLAUDE_DESKTOP_DRIVER_KIND &&
      record.sourceKind === 'provider-jsonl' &&
      typeof record.sourceCursor.byteOffset === 'number'
  )
  const last = records.at(-1)
  if (last !== undefined && rowStillAt(path, last)) {
    const journaled = new Map<number, RawProviderRecord>()
    const pendingOffsets = new Set<number>()
    for (const record of records) {
      if (record.sourceEpoch !== last.sourceEpoch) continue
      const offset = record.sourceCursor.byteOffset as number
      journaled.set(offset, record)
      if (capture?.disposition(record.rawRecordId) === 'pending') pendingOffsets.add(offset)
    }
    return {
      mode: 'resume',
      liveFromByte: (last.sourceCursor.byteOffset as number) + last.rawBytes.length + 1,
      pendingOffsets,
      journaled,
    }
  }
  const cursor = stateDir === undefined ? undefined : readClaudeDesktopCursor(stateDir)
  if (
    cursor !== undefined &&
    cursor.transcriptPath === path &&
    bytesBefore(path, cursor.byteOffset)?.toString('base64') === cursor.anchor
  ) {
    return {
      mode: 'resume-cursor',
      liveFromByte: cursor.byteOffset,
      pendingOffsets: new Set(),
      journaled: new Map(),
    }
  }
  return {
    mode: 'first-join',
    liveFromByte: firstJoinBoundary(path),
    pendingOffsets: new Set(),
    journaled: new Map(),
  }
}

function safeRead(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function bytesBefore(path: string, offset: number): Buffer | undefined {
  const length = Math.min(ANCHOR_BYTES, offset)
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return undefined
  }
  try {
    const bytes = Buffer.alloc(length)
    return readSync(fd, bytes, 0, length, offset - length) === length ? bytes : undefined
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

function rowStillAt(path: string, record: RawProviderRecord): boolean {
  const offset = record.sourceCursor.byteOffset as number
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return false
  }
  try {
    const probe = Buffer.alloc(record.rawBytes.length + 1)
    const read = readSync(fd, probe, 0, probe.length, offset)
    return (
      read === probe.length &&
      probe.subarray(0, record.rawBytes.length).equals(Buffer.from(record.rawBytes)) &&
      probe[record.rawBytes.length] === 0x0a
    )
  } catch {
    return false
  } finally {
    closeSync(fd)
  }
}
