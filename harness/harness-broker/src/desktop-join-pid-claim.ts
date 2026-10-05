import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import {
  type DesktopJoinLog,
  type DesktopThreadPaths,
  processAlive,
  readJoinFile,
} from './desktop-join-thread.js'

export type PidClaim =
  | { claimed: true; previousHolder?: { holderPid: number | null; state: 'dead' | 'stalled' } }
  | {
      claimed: false
      event: 'already-serving' | 'join-in-progress'
      detail: Record<string, unknown>
    }

function readPidHolder(
  pidFile: string
): { raw: string; pid: number | undefined; mtimeMs: number } | undefined {
  try {
    const raw = readFileSync(pidFile, 'utf8')
    const pid = Number(raw.trim())
    return {
      raw,
      // pid 0 or 1 would make `kill(pid, 0)` probe a process group or init.
      pid: Number.isSafeInteger(pid) && pid > 1 ? pid : undefined,
      mtimeMs: statSync(pidFile).mtimeMs,
    }
  } catch {
    return undefined
  }
}

/** True only when `ps` shows the pid is a desktop-join for this very thread. */
function holderIsOurJoiner(pid: number, threadId: string): boolean {
  try {
    const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    return command.includes('desktop-join') && command.includes(threadId)
  } catch {
    return false
  }
}

/**
 * Take broker.pid, the per-thread respawn door. A live holder blocks the door
 * only while it is either serving (join.json says `joined` for that pid) or
 * still inside its join window. A live holder past deadline+grace that never
 * joined is stalled: it is SIGKILLed only when `ps` proves it is our joiner for
 * this thread, and its claim is replaced either way. A stale claim is removed
 * only if it is still the exact claim judged, so two joiners racing for one
 * dead claim cannot both win by overwriting each other.
 */
export function claimBrokerPid(
  paths: DesktopThreadPaths,
  threadId: string,
  staleAfterMs: number,
  log: DesktopJoinLog
): PidClaim {
  let previousHolder: { holderPid: number | null; state: 'dead' | 'stalled' } | undefined
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      writeFileSync(paths.pidFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
      return previousHolder === undefined ? { claimed: true } : { claimed: true, previousHolder }
    } catch (error) {
      if ((error as { code?: string }).code !== 'EEXIST') throw error
    }
    const holder = readPidHolder(paths.pidFile)
    if (holder === undefined) continue
    if (holder.pid !== undefined && processAlive(holder.pid)) {
      const joined = readJoinFile(paths.joinFile)
      if (joined?.['phase'] === 'joined' && joined['pid'] === holder.pid) {
        return { claimed: false, event: 'already-serving', detail: { holderPid: holder.pid } }
      }
      const ageMs = Math.round(Date.now() - holder.mtimeMs)
      if (ageMs < staleAfterMs) {
        return {
          claimed: false,
          event: 'join-in-progress',
          detail: { holderPid: holder.pid, ageMs },
        }
      }
      let killed = false
      if (holderIsOurJoiner(holder.pid, threadId)) {
        try {
          process.kill(holder.pid, 'SIGKILL')
          killed = true
        } catch {}
      }
      log('stalled-holder', { holderPid: holder.pid, ageMs, staleAfterMs, killed })
      previousHolder = { holderPid: holder.pid, state: 'stalled' }
    } else {
      previousHolder = { holderPid: holder.pid ?? null, state: 'dead' }
    }
    if (readPidHolder(paths.pidFile)?.raw === holder.raw) {
      try {
        unlinkSync(paths.pidFile)
      } catch {}
    }
  }
  return { claimed: false, event: 'join-in-progress', detail: { reason: 'claim-contended' } }
}

export function releaseBrokerPid(pidFile: string): void {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile)
  } catch {}
}
