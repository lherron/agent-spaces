import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'
import { DESKTOP_AGENT_ID, DESKTOP_LANE_REF } from './desktop-project.js'

/**
 * Per-thread desktop-join state on disk: the thread dir, its join.log, the
 * join.json write-ahead / joined record, the scope cache the overlay hook
 * reads, and the per-process broker sockets.
 */
export type DesktopJoinLog = (event: string, detail: Record<string, unknown>) => void

export type DesktopThreadPaths = {
  threadDir: string
  joinLog: string
  pidFile: string
  joinFile: string
  scopeCacheFile: string
}

export function threadPaths(codexHome: string, threadId: string): DesktopThreadPaths {
  const threadDir = join(codexHome, 'hrc-desktop', threadId)
  return {
    threadDir,
    joinLog: join(threadDir, 'join.log'),
    pidFile: join(threadDir, 'broker.pid'),
    joinFile: join(threadDir, 'join.json'),
    scopeCacheFile: join(codexHome, 'hrc-desktop-scopes', `${threadId}.json`),
  }
}

export function writeJoinLog(
  joinLog: string,
  event: string,
  detail: Record<string, unknown>
): void {
  mkdirSync(dirname(joinLog), { recursive: true, mode: 0o700 })
  // `pid` and `event` are the writer's and always win over the detail: a holder
  // pid in the detail once overwrote the writer, so the incident log could not
  // say which process wrote a line (T-09977). Holders are `holderPid`.
  const line = { at: new Date().toISOString(), pid: process.pid, event, ...detail }
  line.pid = process.pid
  line.event = event
  appendFileSync(joinLog, `${JSON.stringify(line)}\n`)
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Reap stale per-process broker sockets in the thread dir: entries named
 * `broker-<pid>.sock` whose pid is not alive (kill -9 skips the SIGTERM/SIGINT
 * unlink in `closeBroker`). A socket whose pid is alive — including our own —
 * is never touched: liveness is the only criterion, never age or name order.
 * Returns the reaped paths for the join log.
 */
export function reapStaleSiblingSockets(threadDir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(threadDir)
  } catch {
    return []
  }
  const reaped: string[] = []
  for (const entry of entries) {
    const match = /^broker-(\d+)\.sock$/.exec(entry)
    if (match?.[1] === undefined) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid < 1 || processAlive(pid)) continue
    try {
      unlinkSync(join(threadDir, entry))
      reaped.push(entry)
    } catch {
      // Lost a race with its owner or another reaper; the liveness probe
      // treats a surviving file the same way.
    }
  }
  return reaped
}

export function readJoinFile(joinFile: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(joinFile, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    return parsed as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Connect-level liveness: any answer (even a bootstrap refusal) means a broker serves the path. */
export function probeBrokerSocket(socketPath: string, timeoutMs = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (alive: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        probe.destroy()
      } catch {}
      resolve(alive)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    const probe = connect({ path: socketPath })
    probe.once('connect', () => {
      try {
        probe.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 'desktop-join-probe',
            method: 'broker.hello',
            params: {
              clientInfo: { name: 'harness-broker-desktop-join' },
              protocolVersions: [...SUPPORTED_BROKER_PROTOCOL_VERSIONS],
            },
          })}\n`
        )
      } catch {
        done(true)
        return
      }
      probe.once('data', () => done(true))
      probe.once('error', () => done(true))
      probe.once('close', () => done(false))
    })
    probe.once('error', () => done(false))
  })
}

/** What a previous joiner of this thread left in join.json. */
export type PriorJoin = {
  record: Record<string, unknown>
  /** The live process the record names, when it is not this one. */
  livePid?: number | undefined
  socketPath?: string | undefined
}

export function readPriorJoin(joinFile: string): PriorJoin | undefined {
  const record = readJoinFile(joinFile)
  if (record === undefined) return undefined
  const pid = typeof record['pid'] === 'number' ? (record['pid'] as number) : undefined
  return {
    record,
    ...(pid !== undefined && pid !== process.pid && processAlive(pid) ? { livePid: pid } : {}),
    ...(typeof record['socketPath'] === 'string'
      ? { socketPath: record['socketPath'] as string }
      : {}),
  }
}

/**
 * Write-ahead resume (component 3(v), primary): a previous run persisted its
 * candidate scope with phase 'registering' before calling register. Resume the
 * loop there instead of restarting at primary-nova, so a crash between register
 * and completion converges without parsing refusal text.
 */
export function priorCandidateScope(
  prior: PriorJoin | undefined,
  hostIncarnationId: string
): string | undefined {
  const record = prior?.record
  return record !== undefined &&
    record['phase'] === 'registering' &&
    typeof record['candidateScope'] === 'string' &&
    record['hostIncarnationId'] === hostIncarnationId
    ? (record['candidateScope'] as string)
    : undefined
}

/** A previous joined record pins a respawn to its address and predecessor runtime. */
export function priorRespawn(
  prior: PriorJoin | undefined,
  hostIncarnationId: string
):
  | {
      scopeRef: string
      expectedPredecessor: { hostIncarnationId: string; runtimeId: string; generation: number }
    }
  | undefined {
  const record = prior?.record
  return record !== undefined &&
    typeof record['registrationId'] === 'string' &&
    typeof record['runtimeId'] === 'string' &&
    typeof record['generation'] === 'number' &&
    typeof record['scopeRef'] === 'string'
    ? {
        scopeRef: record['scopeRef'] as string,
        expectedPredecessor: {
          hostIncarnationId:
            typeof record['hostIncarnationId'] === 'string'
              ? (record['hostIncarnationId'] as string)
              : hostIncarnationId,
          runtimeId: record['runtimeId'] as string,
          generation: record['generation'] as number,
        },
      }
    : undefined
}

function writeJsonRecord(path: string, record: Record<string, unknown>): void {
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
}

/** The write-ahead record: the candidate scope about to be registered. */
export function writeJoinCandidate(
  joinFile: string,
  candidate: { scopeRef: string; hostIncarnationId: string }
): void {
  try {
    writeJsonRecord(joinFile, {
      phase: 'registering',
      candidateScope: candidate.scopeRef,
      hostIncarnationId: candidate.hostIncarnationId,
      pid: process.pid,
    })
  } catch {
    // A missed write-ahead only loses the resume shortcut; the join proceeds.
  }
}

export type JoinedRecord = {
  registrationId: string
  attemptId: string
  attachEpoch: number
  hostIncarnationId: string
  runtimeId: string
  generation: number
  scopeRef: string
  socketPath: string
}

/**
 * Record a completed join: join.json (what a later joiner and a respawn read)
 * and the address cache the overlay's PreToolUse hook reads
 * (readEstablishedScope) — same path and same shape the hook expects: scopeRef
 * plus the parsed agent/project/slot identity it injects.
 */
export function writeJoinedRecords(
  paths: DesktopThreadPaths,
  joined: JoinedRecord,
  scope: { projectId: string; threadId: string; projectRoot: string }
): void {
  writeJsonRecord(paths.joinFile, {
    phase: 'joined',
    registrationId: joined.registrationId,
    attemptId: joined.attemptId,
    attachEpoch: joined.attachEpoch,
    hostIncarnationId: joined.hostIncarnationId,
    runtimeId: joined.runtimeId,
    generation: joined.generation,
    scopeRef: joined.scopeRef,
    socketPath: joined.socketPath,
    brokerInstanceId: `broker_${process.pid}`,
    pid: process.pid,
  })
  const slotToken = joined.scopeRef.includes(':task:')
    ? joined.scopeRef.slice(joined.scopeRef.lastIndexOf(':task:') + ':task:'.length)
    : joined.scopeRef
  mkdirSync(dirname(paths.scopeCacheFile), { recursive: true, mode: 0o700 })
  writeJsonRecord(paths.scopeCacheFile, {
    scopeRef: joined.scopeRef,
    agentId: DESKTOP_AGENT_ID,
    projectId: scope.projectId,
    slotToken,
    laneRef: DESKTOP_LANE_REF,
    registrationId: joined.registrationId,
    hostIncarnationId: joined.hostIncarnationId,
    threadId: scope.threadId,
    projectRoot: scope.projectRoot,
    updatedAt: new Date().toISOString(),
  })
}
