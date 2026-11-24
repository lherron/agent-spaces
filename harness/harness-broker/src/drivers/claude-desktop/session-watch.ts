import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** How often the broker checks that its desktop session is still the same live process. */
export const DEFAULT_SESSION_WATCH_INTERVAL_MS = 2_000

/**
 * Why the broker decided its session ended. Archiving a desktop session fires
 * no SessionEnd hook (probed 2026-11-23), so the broker watches for itself.
 */
export type ClaudeDesktopSessionEndReason =
  /** `kill(pid, 0)` finds no process. */
  | 'pid_gone'
  /** `~/.claude/sessions/<pid>.json` is gone, or now names another session. */
  | 'registry_row_gone'
  /** The pid is alive but started at another time than the row says: a reused pid. */
  | 'proc_start_mismatch'

export type ClaudeDesktopSessionCheck =
  | { alive: true }
  | { alive: false; reason: ClaudeDesktopSessionEndReason; detail: Record<string, unknown> }

/** The process facts the check reads; real by default, swapped in tests. */
export interface ClaudeDesktopSessionProbe {
  pidAlive(pid: number): boolean
  /** `ps -o lstart=` in the C locale and UTC, the format the registry row's `procStart` uses. */
  procStart(pid: number): Promise<string | undefined>
}

export const systemSessionProbe: ClaudeDesktopSessionProbe = {
  pidAlive(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  procStart(pid) {
    return new Promise((resolve) => {
      execFile(
        'ps',
        ['-o', 'lstart=', '-p', String(pid)],
        { env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }, timeout: 1_000 },
        (error, stdout) => {
          const value = normalizeProcStart(String(stdout ?? ''))
          resolve(error === null && value.length > 0 ? value : undefined)
        }
      )
    })
  },
}

function normalizeProcStart(value: string): string {
  return value.trim().replace(/\s+/g, ' ')
}

type RowRead =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'present'; sessionId: unknown; procStart: unknown }

async function readRow(claudeHome: string, pid: number): Promise<RowRead> {
  let raw: string
  try {
    raw = await readFile(join(claudeHome, 'sessions', `${pid}.json`), 'utf8')
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unreadable' }
  }
  try {
    const row = JSON.parse(raw) as Record<string, unknown>
    if (typeof row !== 'object' || row === null) return { state: 'unreadable' }
    return { state: 'present', sessionId: row['sessionId'], procStart: row['procStart'] }
  } catch {
    // Caught mid-rewrite: no verdict this tick.
    return { state: 'unreadable' }
  }
}

/**
 * One liveness check of a desktop session: its pid is alive, its registry row
 * still names this session, and the pid started when the row says it did.
 * Anything this check cannot read (a row caught mid-write, `ps` failing on a
 * live pid) is no verdict, never a death.
 */
export async function checkClaudeDesktopSession(input: {
  claudeHome: string
  sessionId: string
  pid: number
  probe?: ClaudeDesktopSessionProbe | undefined
}): Promise<ClaudeDesktopSessionCheck> {
  const { claudeHome, sessionId, pid } = input
  const probe = input.probe ?? systemSessionProbe
  if (!probe.pidAlive(pid)) return { alive: false, reason: 'pid_gone', detail: { sessionPid: pid } }
  const row = await readRow(claudeHome, pid)
  if (row.state === 'missing') {
    return { alive: false, reason: 'registry_row_gone', detail: { sessionPid: pid } }
  }
  if (row.state === 'unreadable') return { alive: true }
  if (row.sessionId !== sessionId) {
    return {
      alive: false,
      reason: 'registry_row_gone',
      detail: {
        sessionPid: pid,
        rowSessionId: typeof row.sessionId === 'string' ? row.sessionId : null,
      },
    }
  }
  if (typeof row.procStart !== 'string') return { alive: true }
  const expected = normalizeProcStart(row.procStart)
  const actual = await probe.procStart(pid)
  if (actual === undefined) {
    return probe.pidAlive(pid)
      ? { alive: true }
      : { alive: false, reason: 'pid_gone', detail: { sessionPid: pid } }
  }
  if (actual !== expected) {
    return {
      alive: false,
      reason: 'proc_start_mismatch',
      detail: { sessionPid: pid, rowProcStart: expected, processStart: actual },
    }
  }
  return { alive: true }
}
