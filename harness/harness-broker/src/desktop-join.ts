import { execFileSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import {
  type CodexDesktopParticipantPreparation,
  createCodexDesktopParticipantAdapter,
} from 'agent-spaces'
import { SUPPORTED_BROKER_PROTOCOL_VERSIONS } from 'spaces-harness-broker-protocol'
import {
  type JoinPrepareInput,
  attachParticipant,
  isHostBindingConflict,
  isIncarnationBoundElsewhere,
  isRedirect,
  isScopeOccupied,
  isScopeRetired,
  registerParticipant,
} from 'spaces-hrc-join-client'
import type { ParticipantAdapter } from 'spaces-runtime-contracts'
import {
  DESKTOP_AGENT_ID,
  DESKTOP_LANE_REF,
  type WrkqRegistryProject,
  desktopHostIncarnationId,
  desktopScopeRef,
  desktopSlotTokenSequence,
  readRegistryProjects,
  resolveDesktopProject,
} from './desktop-project.js'
import { assertSocketPathWithinBudget } from './socket-path.js'
import { serveUnixBroker } from './unix-broker.js'

export type DesktopJoinInput = {
  threadId: string
  codexHome: string
  rolloutPath?: string | undefined
  workspaceCwd?: string | undefined
  fallbackHomeDir?: string | undefined
  sqliteHome?: string | undefined
  reportedBundleExecutable?: string | undefined
  operatorBundleExecutable?: string | undefined
  hrcSocketPath: string
  hookSource?: string | undefined
  projectRoot?: string | undefined
  registryProjects?: readonly WrkqRegistryProject[] | undefined
  agentsRoot?: string | undefined
  /** Join deadline; defaults to DEFAULT_JOIN_DEADLINE_MS. */
  deadlineMs?: number | undefined
}

export type DesktopAdmission =
  | {
      admitted: true
      preparation: CodexDesktopParticipantPreparation
      participantKey: string
      workspaceCwd: string
      homeIdentity: string
    }
  | { admitted: false; reason: string; detail?: string | undefined }

export async function admitDesktopThread(input: {
  threadId: string
  codexHome: string
  rolloutPath?: string | undefined
  workspaceCwd?: string | undefined
  fallbackHomeDir?: string | undefined
  sqliteHome?: string | undefined
  reportedBundleExecutable?: string | undefined
  operatorBundleExecutable?: string | undefined
  projectRoot?: string | undefined
  nativeAttemptStorePath?: string | undefined
}): Promise<DesktopAdmission> {
  const adapter = createCodexDesktopParticipantAdapter()
  const admission = await adapter.admit({
    classId: 'codex-desktop',
    join: 'participant-served',
    evidence: {
      schema: 'codex-desktop.participant-evidence/1',
      nativeThreadId: input.threadId,
      reported: {
        ...(input.codexHome === undefined ? {} : { codexHome: input.codexHome }),
        ...(input.sqliteHome === undefined ? {} : { sqliteHome: input.sqliteHome }),
        ...(input.rolloutPath === undefined ? {} : { rolloutPath: input.rolloutPath }),
      },
      fallbackHomeDir: input.fallbackHomeDir ?? process.env['HOME'] ?? tmpdir(),
      ...(input.workspaceCwd === undefined ? {} : { reportedWorkspaceCwd: input.workspaceCwd }),
      ...(input.reportedBundleExecutable === undefined
        ? {}
        : { reportedBundleExecutable: input.reportedBundleExecutable }),
      ...(input.operatorBundleExecutable === undefined
        ? {}
        : { operatorBundleExecutable: input.operatorBundleExecutable }),
      projectRoot: input.projectRoot ?? input.workspaceCwd ?? process.cwd(),
      nativeAttemptStorePath:
        input.nativeAttemptStorePath ??
        join(input.codexHome, 'hrc-desktop', input.threadId, 'native-attempts.db'),
    },
  })
  if (admission.status !== 'admitted') {
    const reason =
      admission.status === 'pending' || admission.status === 'rejected'
        ? admission.reason
        : 'unknown'
    return { admitted: false, reason }
  }
  const preparation = admission.preparation as unknown as CodexDesktopParticipantPreparation
  return {
    admitted: true,
    preparation,
    participantKey: admission.participantKey,
    workspaceCwd: admission.workspaceCwd,
    homeIdentity: preparation.homeIdentity,
  }
}

export type ScopeJoinInput = {
  hrcSocketPath: string
  projectId: string
  hostIncarnationId: string
  socketPath: string
  classId: string
  participantKey: string
  workspaceCwd: string
  preparation: JoinPrepareInput['preparation']
  expectedPredecessor?:
    | { hostIncarnationId: string; runtimeId: string; generation: number }
    | undefined
  scopeRef?: string | undefined
  adapter?: ParticipantAdapter | undefined
  maxSlots?: number | undefined
  resumeFromScope?: string | undefined
  onCandidateScope?: ((scopeRef: string) => void) | undefined
  /** Bound on each HRC register/attach exchange; a timeout throws like any transport failure. */
  requestTimeoutMs?: number | undefined
}

export type ScopeJoinOutcome =
  | {
      exit: 'joined'
      scopeRef: string
      registrationId: string
      attemptId: string
      attachEpoch: number
      runtimeId: string
      generation: number
      hostSessionId: string
    }
  | { exit: 'pending-hold'; scopeRef: string; reason: string; detail: string }
  | { exit: 'redirect'; scopeRef: string; reason: string; homeNodeId?: string | undefined }
  | { exit: 'not-prepared'; scopeRef: string; reason: string }
  | { exit: 'attach-refused'; scopeRef: string; reason: string; detail: string }
  | { exit: 'register-refused'; scopeRef: string; reason: string; detail: string }
  | { exit: 'scope-exhausted'; detail: string }

/**
 * Scope choice with the exact 409 partition from the spec (component 4):
 * `registered` → prepare → attach; `participant_scope_occupied` /
 * `host_binding_conflict` → ADVANCE; `*_bound_elsewhere` /
 * `*_birth_designated_elsewhere` → redirect without advancing; `pending` →
 * hold for the next hook. A caller-supplied `scopeRef` (respawn) pins the
 * loop to one address with `expectedPredecessor`. A `resumeFromScope` seed
 * (from a write-ahead join.json, component 3(v)) is tried before the sequence.
 */
/**
 * The address our own incarnation already holds, when HRC names it in an
 * `participant_host_incarnation_bound_elsewhere` refusal. HRC checks the
 * incarnation binding before address occupancy, so a slot loop that restarts
 * at `primary-nova` can never reach its own held slot by advancing — it jumps
 * to the named address, where the same-incarnation register replays. This is
 * the fallback for the crash window the write-ahead record does not cover.
 */
export function heldScopeFromIncarnationRefusal(detail: string): string | undefined {
  const match = /already holds (agent:[^;\s]+);/.exec(detail)
  return match?.[1]
}

export async function chooseScopeAndJoin(input: ScopeJoinInput): Promise<ScopeJoinOutcome> {
  const adapter = input.adapter ?? createCodexDesktopParticipantAdapter()
  const slots: Iterator<string> =
    input.scopeRef !== undefined
      ? scopeRefsForPinned(input.scopeRef)
      : scopeRefsFor(input.projectId, input.maxSlots)
  const tried = new Set<string>()
  const queue: string[] =
    input.resumeFromScope !== undefined && input.scopeRef === undefined
      ? [input.resumeFromScope]
      : []
  const next = (): string | undefined => {
    for (;;) {
      const fromQueue = queue.shift()
      if (fromQueue !== undefined) {
        if (!tried.has(fromQueue)) return fromQueue
        continue
      }
      const fromSlots = slots.next()
      if (fromSlots.done === true) return undefined
      if (!tried.has(fromSlots.value)) return fromSlots.value
    }
  }
  const requestOptions = { timeoutMs: input.requestTimeoutMs }
  let examined = 0
  let scopeRef = next()
  while (scopeRef !== undefined) {
    tried.add(scopeRef)
    examined += 1
    input.onCandidateScope?.(scopeRef)
    const register = await registerParticipant(
      input.hrcSocketPath,
      {
        registrationMode: 'direct',
        requestedSessionRef: scopeRef,
        hostIncarnationId: input.hostIncarnationId,
        laneRef: DESKTOP_LANE_REF,
        classId: input.classId,
        participantKey: input.participantKey,
        workspaceCwd: input.workspaceCwd,
        socketPath: input.socketPath,
        ...(input.expectedPredecessor === undefined
          ? {}
          : { expectedPredecessor: input.expectedPredecessor }),
      },
      requestOptions
    )
    if (register.outcome !== 'registered') {
      if (register.outcome === 'pending') {
        return { exit: 'pending-hold', scopeRef, reason: register.reason, detail: register.detail }
      }
      // A slot this node permanently retired can never be ours again, so it
      // advances like an occupied one. Stopping there left the thread on its
      // provisional codex-<uuid> address, and mail to that address cold-birthed
      // a CLI seat (2026-09-26, arris:primary-quasar).
      if (
        isScopeOccupied(register) ||
        isHostBindingConflict(register) ||
        isScopeRetired(register)
      ) {
        if (input.scopeRef !== undefined) {
          return {
            exit: 'register-refused',
            scopeRef,
            reason: register.reason,
            detail: register.detail,
          }
        }
        scopeRef = next()
        continue
      }
      if (isIncarnationBoundElsewhere(register)) {
        const held = heldScopeFromIncarnationRefusal(register.detail)
        if (held !== undefined && !tried.has(held)) {
          queue.push(held)
          scopeRef = next()
          continue
        }
      }
      if (isRedirect(register)) {
        return {
          exit: 'redirect',
          scopeRef,
          reason: register.reason,
          ...(register.observed?.homeNodeId === undefined
            ? {}
            : { homeNodeId: register.observed.homeNodeId }),
        }
      }
      return {
        exit: 'register-refused',
        scopeRef,
        reason: register.reason,
        detail: register.detail,
      }
    }
    const prepared = await adapter.prepare({
      classId: input.classId,
      join: 'participant-served',
      participantKey: input.participantKey,
      workspaceCwd: input.workspaceCwd,
      preparation: input.preparation as never,
      identity: {
        requestId: register.identity.requestId as never,
        operationId: register.identity.operationId as never,
        hostSessionId: register.hostSessionId as never,
        generation: register.generation,
        runtimeId: register.identity.runtimeId as never,
        invocationId: register.identity.invocationId as never,
      },
      scopeRef: register.scopeRef,
      laneRef: register.identity.laneRef,
      attachEpoch: register.identity.attachEpoch,
    })
    if (prepared.status !== 'prepared') {
      return { exit: 'not-prepared', scopeRef, reason: prepared.reason }
    }
    const attach = await attachParticipant(
      input.hrcSocketPath,
      {
        registrationId: register.identity.registrationId,
        attemptId: register.identity.attemptId,
        attachEpoch: register.identity.attachEpoch,
        socketPath: input.socketPath,
        descriptor: prepared.descriptor,
      },
      requestOptions
    )
    if (attach.outcome !== 'attached') {
      if (attach.outcome === 'pending') {
        return { exit: 'pending-hold', scopeRef, reason: attach.reason, detail: attach.detail }
      }
      return { exit: 'attach-refused', scopeRef, reason: attach.reason, detail: attach.detail }
    }
    return {
      exit: 'joined',
      scopeRef: register.scopeRef,
      registrationId: register.identity.registrationId,
      attemptId: register.identity.attemptId,
      attachEpoch: register.identity.attachEpoch,
      runtimeId: register.identity.runtimeId,
      generation: register.generation,
      hostSessionId: register.hostSessionId,
    }
  }
  return { exit: 'scope-exhausted', detail: `examined ${examined} slots without a join` }
}

function* scopeRefsForPinned(scopeRef: string): Generator<string, void, void> {
  yield scopeRef
}

function* scopeRefsFor(projectId: string, maxSlots?: number): Generator<string, void, void> {
  let count = 0
  for (const slot of desktopSlotTokenSequence()) {
    yield desktopScopeRef(DESKTOP_AGENT_ID, projectId, slot)
    count += 1
    if (maxSlots !== undefined && count >= maxSlots) break
  }
}

export type DesktopJoinLog = (event: string, detail: Record<string, unknown>) => void

export function threadPaths(
  codexHome: string,
  threadId: string
): {
  threadDir: string
  joinLog: string
  pidFile: string
  joinFile: string
  scopeCacheFile: string
} {
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

function processAlive(pid: number): boolean {
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

function readJoinFile(joinFile: string): Record<string, unknown> | undefined {
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

export type DesktopJoinOutcome =
  | { exit: 0; reason: string; scopeRef?: string | undefined }
  | { exit: 1; reason: string }

/** Where a joiner is; every termination line in join.log carries it. */
export type JoinPhase =
  | 'starting'
  | 'admitting'
  | 'claiming'
  | 'resolving-project'
  | 'serving-socket'
  | 'registering'
  | 'joined'

/**
 * Process-level join state, shared with the CLI's termination logging so an
 * uncaught throw, a signal or the deadline can name the phase, release the
 * broker.pid claim and close the socket, wherever the joiner was.
 */
export type JoinLifecycle = {
  phase: JoinPhase
  log?: DesktopJoinLog | undefined
  /** Removes broker.pid when, and only when, it still names this process. */
  release?: (() => void) | undefined
  closeBroker?: (() => Promise<void>) | undefined
}

export type DesktopJoinDeps = {
  serve?: typeof serveUnixBroker | undefined
  blockForever?: (() => Promise<never>) | undefined
  lifecycle?: JoinLifecycle | undefined
  /** Called when the join deadline fires before `joined`. Defaults to releasing and exiting 0. */
  onDeadline?: (() => void) | undefined
}

/**
 * A joiner that has not reached `joined` by this deadline logs `join-deadline`,
 * releases broker.pid and exits: the respawn door is never held by a joiner
 * that is not making progress (T-09977).
 */
export const DEFAULT_JOIN_DEADLINE_MS = 60_000
/**
 * How long past its own deadline a later joiner waits on a live, unjoined
 * holder before calling it stalled. The holder's own deadline normally fires
 * first; this covers a holder that cannot run its timer (blocked event loop)
 * and a pid reused by an unrelated process.
 */
export const STALLED_HOLDER_GRACE_MS = 15_000
const REGISTRY_CACHE_FILE = 'hrc-desktop-registry.json'
const MAX_BACKOFF_MS = 5_000

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type PidClaim =
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
function claimBrokerPid(
  paths: ReturnType<typeof threadPaths>,
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

function releaseBrokerPid(pidFile: string): void {
  try {
    if (readFileSync(pidFile, 'utf8').trim() === String(process.pid)) unlinkSync(pidFile)
  } catch {}
}

type RegistryCache = { fetchedAt: string; projects: WrkqRegistryProject[] }

function readRegistryCache(cacheFile: string): RegistryCache | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cacheFile, 'utf8')) as Partial<RegistryCache>
    if (typeof parsed.fetchedAt !== 'string' || !Array.isArray(parsed.projects)) return undefined
    return { fetchedAt: parsed.fetchedAt, projects: parsed.projects }
  } catch {
    return undefined
  }
}

function writeRegistryCache(cacheFile: string, projects: WrkqRegistryProject[]): void {
  try {
    mkdirSync(dirname(cacheFile), { recursive: true, mode: 0o700 })
    const temp = `${cacheFile}.${process.pid}.tmp`
    writeFileSync(
      temp,
      `${JSON.stringify({ fetchedAt: new Date().toISOString(), projects }, null, 2)}\n`,
      { mode: 0o600 }
    )
    renameSync(temp, cacheFile)
  } catch {
    // A missed refresh only ages the last-good copy.
  }
}

/**
 * The wrkq project registry, or the last copy that answered. wrkq is an RPC
 * client of a remote ledger: a slow or failed read is an outage to ride out,
 * the same way HRC's own registry serves last-good (T-09977).
 */
async function readRegistry(
  cacheFile: string,
  timeoutMs: number,
  log: DesktopJoinLog
): Promise<{ projects: WrkqRegistryProject[] } | { error: string }> {
  try {
    const projects = await readRegistryProjects(timeoutMs)
    writeRegistryCache(cacheFile, projects)
    return { projects }
  } catch (error) {
    const message = errorMessage(error)
    const cache = readRegistryCache(cacheFile)
    if (cache === undefined) return { error: message }
    log('registry-last-good', {
      message,
      ageMs: Math.max(0, Date.now() - Date.parse(cache.fetchedAt)),
    })
    return { projects: cache.projects }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))

/**
 * `harness-broker desktop-join`: hook-started self-join for one Desktop thread.
 * Every non-serving path exits 0 with a typed reason in join.log — a missed
 * join is normal state (subagent thread, daemon restarting), never a hook
 * failure. Only malformed input exits 1.
 *
 * Every blocking step is bounded: the wrkq registry read and each HRC request
 * carry a timeout, transient failures retry with backoff inside one deadline,
 * and a joiner that misses the deadline logs `join-deadline` and releases
 * broker.pid so the next hook can try (T-09977).
 */
export async function runDesktopJoin(
  input: DesktopJoinInput,
  deps: DesktopJoinDeps = {}
): Promise<DesktopJoinOutcome> {
  const startedAt = Date.now()
  const paths = threadPaths(input.codexHome, input.threadId)
  const log: DesktopJoinLog = (event, detail) => writeJoinLog(paths.joinLog, event, detail)
  const lifecycle: JoinLifecycle = deps.lifecycle ?? { phase: 'starting' }
  lifecycle.log = log
  const deadlineMs = input.deadlineMs ?? DEFAULT_JOIN_DEADLINE_MS
  const registryTimeoutMs = Math.min(5_000, Math.max(250, Math.floor(deadlineMs / 4)))
  const requestTimeoutMs = Math.min(10_000, Math.max(500, Math.floor(deadlineMs / 3)))
  const deadlineAt = startedAt + deadlineMs
  const remainingMs = (): number => deadlineAt - Date.now()

  let expired = false
  const expire = (): DesktopJoinOutcome => {
    if (!expired) {
      expired = true
      log('join-deadline', {
        phase: lifecycle.phase,
        deadlineMs,
        elapsedMs: Date.now() - startedAt,
      })
    }
    return { exit: 0, reason: 'join-deadline' }
  }
  // Backstop for a step that never returns: the loops below check the
  // deadline between attempts, this fires inside a hung await.
  const deadlineTimer = setTimeout(() => {
    if (lifecycle.phase === 'joined') return
    expire()
    if (deps.onDeadline !== undefined) {
      deps.onDeadline()
      return
    }
    lifecycle.release?.()
    void Promise.resolve()
      .then(() => lifecycle.closeBroker?.())
      .catch(() => {})
      .then(() => process.exit(0))
  }, deadlineMs)

  try {
    lifecycle.phase = 'admitting'
    const admission = await admitDesktopThread({
      threadId: input.threadId,
      codexHome: input.codexHome,
      ...(input.rolloutPath === undefined ? {} : { rolloutPath: input.rolloutPath }),
      ...(input.workspaceCwd === undefined ? {} : { workspaceCwd: input.workspaceCwd }),
      ...(input.fallbackHomeDir === undefined ? {} : { fallbackHomeDir: input.fallbackHomeDir }),
      ...(input.sqliteHome === undefined ? {} : { sqliteHome: input.sqliteHome }),
      ...(input.reportedBundleExecutable === undefined
        ? {}
        : { reportedBundleExecutable: input.reportedBundleExecutable }),
      ...(input.operatorBundleExecutable === undefined
        ? {}
        : { operatorBundleExecutable: input.operatorBundleExecutable }),
      ...(input.projectRoot === undefined ? {} : { projectRoot: input.projectRoot }),
      nativeAttemptStorePath: join(paths.threadDir, 'native-attempts.db'),
    })
    if (!admission.admitted) {
      log('not-admitted', { reason: admission.reason, source: input.hookSource ?? 'unknown' })
      return { exit: 0, reason: `not-admitted:${admission.reason}` }
    }

    lifecycle.phase = 'claiming'
    mkdirSync(paths.threadDir, { recursive: true, mode: 0o700 })
    const claim = claimBrokerPid(paths, input.threadId, deadlineMs + STALLED_HOLDER_GRACE_MS, log)
    if (!claim.claimed) {
      log(claim.event, claim.detail)
      return { exit: 0, reason: claim.event }
    }
    lifecycle.release = () => releaseBrokerPid(paths.pidFile)
    log('claimed', {
      source: input.hookSource ?? 'unknown',
      deadlineMs,
      ...(claim.previousHolder === undefined
        ? {}
        : {
            previousHolderPid: claim.previousHolder.holderPid,
            previousHolder: claim.previousHolder.state,
          }),
    })

    const reaped = reapStaleSiblingSockets(paths.threadDir)
    if (reaped.length > 0) {
      log('reaped-stale-sockets', { sockets: reaped })
    }

    const prior = readJoinFile(paths.joinFile)
    if (prior !== undefined) {
      const priorPid = typeof prior['pid'] === 'number' ? (prior['pid'] as number) : undefined
      if (priorPid !== undefined && priorPid !== process.pid && processAlive(priorPid)) {
        log('already-serving', { holderPid: priorPid, via: 'join.json' })
        return { exit: 0, reason: 'already-serving' }
      }
      if (typeof prior['socketPath'] === 'string') {
        const alive = await probeBrokerSocket(prior['socketPath'] as string)
        if (alive) {
          log('already-serving', { socketPath: prior['socketPath'] })
          return { exit: 0, reason: 'already-serving' }
        }
      }
    }

    lifecycle.phase = 'resolving-project'
    let project: Awaited<ReturnType<typeof resolveDesktopProject>>
    if (input.projectRoot !== undefined) {
      project = {
        bound: {
          projectId: basenameOf(input.projectRoot),
          projectRoot: input.projectRoot,
          resolvedBy: 'override',
        },
      }
    } else {
      let registryProjects = input.registryProjects
      for (let attempt = 1; registryProjects === undefined; attempt += 1) {
        const registry = await readRegistry(
          join(input.codexHome, REGISTRY_CACHE_FILE),
          Math.min(registryTimeoutMs, Math.max(1, remainingMs())),
          log
        )
        if ('projects' in registry) {
          registryProjects = registry.projects
          break
        }
        const waitMs = backoffMs(attempt)
        const retryable = remainingMs() > waitMs
        log('registry-unavailable', {
          message: registry.error,
          attempt,
          retryable,
          ...(retryable ? { nextRetryMs: waitMs } : {}),
        })
        if (!retryable) return expire()
        await sleep(waitMs)
      }
      project = await resolveDesktopProject({
        workspaceCwd: admission.workspaceCwd,
        registryProjects,
        ...(input.agentsRoot === undefined ? {} : { agentsRoot: input.agentsRoot }),
      })
    }
    if (!('bound' in project)) {
      log('no-project', { reason: project.reason, detail: project.detail })
      return { exit: 0, reason: `no-project:${project.reason}` }
    }

    const hostIncarnationId = desktopHostIncarnationId(admission.homeIdentity, input.threadId)
    const socketPath = join(paths.threadDir, `broker-${process.pid}.sock`)
    try {
      assertSocketPathWithinBudget(socketPath)
    } catch (error) {
      log('socket-path-over-budget', { message: errorMessage(error) })
      return { exit: 0, reason: 'socket-path-over-budget' }
    }

    lifecycle.phase = 'serving-socket'
    const serve = deps.serve ?? serveUnixBroker
    try {
      const served = await serve({
        socketPath,
        cliOptions: {},
        participantBootstrap: true,
        // HRC's controller reattach replays events (eventsSince) and acks them;
        // without a durable ledger both throw EventReplayUnavailable and the
        // runtime never leaves starting. The ledger lives in the thread dir so
        // a respawn replays rather than re-emits pre-kill turns.
        ledgerPath: join(paths.threadDir, 'event-ledger.sqlite'),
        onServerError: (error) => {
          writeJoinLog(paths.joinLog, 'server-error', { message: error.message })
        },
      })
      // Released on every exit path (signal, deadline, crash) by the CLI's
      // termination handling, so a respawn starts from a dead socket. A kill -9
      // skips it; the next hook's liveness probe covers that path.
      lifecycle.closeBroker = served.close
    } catch (error) {
      log('serve-failed', { message: errorMessage(error) })
      return { exit: 0, reason: 'serve-failed' }
    }

    // Write-ahead resume (component 3(v), primary): a previous run persisted
    // its candidate scope with phase 'registering' before calling register. Resume
    // the loop there instead of restarting at primary-nova, so a crash between
    // register and completion converges without parsing refusal text.
    let resumeFromScope =
      prior !== undefined &&
      prior['phase'] === 'registering' &&
      typeof prior['candidateScope'] === 'string' &&
      prior['hostIncarnationId'] === hostIncarnationId
        ? (prior['candidateScope'] as string)
        : undefined

    const writeCandidate = (scopeRef: string): void => {
      // A retry after a lost register reply resumes at the same address,
      // where the same-incarnation register replays.
      resumeFromScope = scopeRef
      try {
        writeFileSync(
          paths.joinFile,
          `${JSON.stringify(
            {
              phase: 'registering',
              candidateScope: scopeRef,
              hostIncarnationId,
              pid: process.pid,
            },
            null,
            2
          )}\n`,
          { mode: 0o600 }
        )
      } catch {
        // A missed write-ahead only loses the resume shortcut; the join proceeds.
      }
    }

    const respawn =
      prior !== undefined &&
      typeof prior['registrationId'] === 'string' &&
      typeof prior['runtimeId'] === 'string' &&
      typeof prior['generation'] === 'number' &&
      typeof prior['scopeRef'] === 'string'
        ? {
            scopeRef: prior['scopeRef'] as string,
            expectedPredecessor: {
              hostIncarnationId:
                typeof prior['hostIncarnationId'] === 'string'
                  ? (prior['hostIncarnationId'] as string)
                  : hostIncarnationId,
              runtimeId: prior['runtimeId'] as string,
              generation: prior['generation'] as number,
            },
          }
        : undefined

    lifecycle.phase = 'registering'
    let outcome: Awaited<ReturnType<typeof chooseScopeAndJoin>> | undefined
    for (let attempt = 1; outcome === undefined; attempt += 1) {
      try {
        outcome = await chooseScopeAndJoin({
          hrcSocketPath: input.hrcSocketPath,
          projectId: project.bound.projectId,
          hostIncarnationId,
          socketPath,
          classId: 'codex-desktop',
          participantKey: admission.participantKey,
          workspaceCwd: admission.workspaceCwd,
          preparation: {
            schema: 'codex-desktop.participant-preparation/1',
            nativeThreadId: input.threadId,
            homeIdentity: admission.homeIdentity,
            sqliteHome: admission.preparation.sqliteHome,
            registrationKey: admission.preparation.registrationKey,
            rolloutPath: admission.preparation.rolloutPath,
            workspaceCwd: admission.workspaceCwd,
            ...(admission.preparation.reportedBundleExecutable === undefined
              ? {}
              : { reportedBundleExecutable: admission.preparation.reportedBundleExecutable }),
            ...(admission.preparation.operatorBundleExecutable === undefined
              ? {}
              : { operatorBundleExecutable: admission.preparation.operatorBundleExecutable }),
            projectRoot: admission.preparation.projectRoot,
            nativeAttemptStorePath: join(paths.threadDir, 'native-attempts.db'),
          },
          ...(respawn === undefined ? {} : respawn),
          ...(resumeFromScope === undefined ? {} : { resumeFromScope }),
          onCandidateScope: writeCandidate,
          requestTimeoutMs: Math.min(requestTimeoutMs, Math.max(1, remainingMs())),
        })
      } catch (error) {
        const waitMs = backoffMs(attempt)
        const retryable = remainingMs() > waitMs
        log('join-transport-error', {
          message: errorMessage(error),
          attempt,
          retryable,
          ...(retryable ? { nextRetryMs: waitMs } : {}),
        })
        if (!retryable) return expire()
        await sleep(waitMs)
      }
    }

    if (outcome.exit !== 'joined') {
      log('join-refused', { ...outcome })
      return { exit: 0, reason: `join-${outcome.exit}` }
    }

    const brokerInstanceId = `broker_${process.pid}`
    writeFileSync(
      paths.joinFile,
      `${JSON.stringify(
        {
          phase: 'joined',
          registrationId: outcome.registrationId,
          attemptId: outcome.attemptId,
          attachEpoch: outcome.attachEpoch,
          hostIncarnationId,
          runtimeId: outcome.runtimeId,
          generation: outcome.generation,
          scopeRef: outcome.scopeRef,
          socketPath,
          brokerInstanceId,
          pid: process.pid,
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    // The address cache the overlay's PreToolUse hook reads
    // (readEstablishedScope): same path and same shape the hook expects —
    // scopeRef plus the parsed agent/project/slot identity it injects.
    const slotToken = outcome.scopeRef.includes(':task:')
      ? outcome.scopeRef.slice(outcome.scopeRef.lastIndexOf(':task:') + ':task:'.length)
      : outcome.scopeRef
    mkdirSync(dirname(paths.scopeCacheFile), { recursive: true, mode: 0o700 })
    writeFileSync(
      paths.scopeCacheFile,
      `${JSON.stringify(
        {
          scopeRef: outcome.scopeRef,
          agentId: DESKTOP_AGENT_ID,
          projectId: project.bound.projectId,
          slotToken,
          laneRef: DESKTOP_LANE_REF,
          registrationId: outcome.registrationId,
          hostIncarnationId,
          threadId: input.threadId,
          projectRoot: admission.workspaceCwd,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`,
      { mode: 0o600 }
    )
    lifecycle.phase = 'joined'
    clearTimeout(deadlineTimer)
    log('joined', {
      scopeRef: outcome.scopeRef,
      registrationId: outcome.registrationId,
      attachEpoch: outcome.attachEpoch,
      respawn: respawn !== undefined,
      elapsedMs: Date.now() - startedAt,
    })
  } finally {
    clearTimeout(deadlineTimer)
  }

  const blockForever = deps.blockForever ?? (async () => new Promise<never>(() => {}))
  await blockForever()
  return { exit: 0, reason: 'serving' }
}

function basenameOf(path: string): string {
  return basename(resolve(path))
}

export function parseDesktopJoinArgs(args: string[]): DesktopJoinInput {
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(name)
    return index === -1 ? undefined : args[index + 1]
  }
  const threadId = flag('--thread')
  const codexHome =
    flag('--codex-home') ??
    process.env['CODEX_HOME'] ??
    join(process.env['HOME'] ?? tmpdir(), '.codex')
  const hrcSocketPath =
    flag('--hrc-socket') ??
    process.env['HRC_CALLBACK_SOCKET'] ??
    join(process.env['HOME'] ?? tmpdir(), 'praesidium', 'var', 'run', 'hrc', 'hrc.sock')
  if (threadId === undefined || threadId.length === 0) {
    throw new Error(
      'Usage: harness-broker desktop-join --thread <id> [--rollout <path> --cwd <dir> --codex-home <dir> --hrc-socket <path> --source <hook> --deadline-ms <ms>]'
    )
  }
  const rolloutPath = flag('--rollout')
  const workspaceCwd = flag('--cwd')
  const deadlineFlag = flag('--deadline-ms')
  const deadlineMs = deadlineFlag === undefined ? undefined : Number(deadlineFlag)
  if (deadlineMs !== undefined && !(Number.isSafeInteger(deadlineMs) && deadlineMs > 0)) {
    throw new Error(`--deadline-ms must be a positive integer, got ${deadlineFlag}`)
  }
  return {
    ...(deadlineMs === undefined ? {} : { deadlineMs }),
    threadId,
    codexHome,
    hrcSocketPath,
    ...(rolloutPath === undefined ? {} : { rolloutPath }),
    ...(workspaceCwd === undefined ? {} : { workspaceCwd }),
    ...(flag('--sqlite-home') === undefined ? {} : { sqliteHome: flag('--sqlite-home') }),
    ...(flag('--bundle-executable') === undefined
      ? {}
      : { reportedBundleExecutable: flag('--bundle-executable') }),
    ...(flag('--source') === undefined ? {} : { hookSource: flag('--source') }),
  }
}

export function readHookStdinIds(raw: string): {
  threadId?: string
  rolloutPath?: string
  workspaceCwd?: string
  source?: string
} {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record['session_id'] === 'string'
        ? { threadId: record['session_id'] as string }
        : {}),
      ...(typeof record['transcript_path'] === 'string'
        ? { rolloutPath: record['transcript_path'] as string }
        : {}),
      ...(typeof record['cwd'] === 'string' ? { workspaceCwd: record['cwd'] as string } : {}),
      ...(typeof record['source'] === 'string' ? { source: record['source'] as string } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Every way a joiner process ends leaves a typed join.log line naming the
 * phase: `crashed` (uncaught throw / unhandled rejection), `signal`, and a
 * final `exit` with the code. Each path releases broker.pid and closes the
 * socket first. Only SIGKILL escapes; the next joiner logs the takeover of its
 * dead claim (T-09977).
 */
function installTerminationLogging(lifecycle: JoinLifecycle): void {
  const write = (event: string, detail: Record<string, unknown>): void => {
    try {
      if (lifecycle.log !== undefined) {
        lifecycle.log(event, { phase: lifecycle.phase, ...detail })
        return
      }
    } catch {}
    // No thread yet (bad argv), or join.log unwritable: stderr goes to the
    // hook's joiner.stderr.log.
    process.stderr.write(`desktop-join ${event} ${JSON.stringify(detail)}\n`)
  }
  let finishing = false
  const finish = (code: number): void => {
    if (finishing) return
    finishing = true
    try {
      lifecycle.release?.()
    } catch {}
    void Promise.resolve()
      .then(() => lifecycle.closeBroker?.())
      .catch(() => {})
      .then(() => process.exit(code))
  }
  const crashed = (kind: string, error: unknown): void => {
    write('crashed', {
      kind,
      message: errorMessage(error),
      ...(error instanceof Error && error.stack !== undefined
        ? { stack: error.stack.split('\n').slice(0, 6).join('\n') }
        : {}),
    })
    finish(1)
  }
  process.on('uncaughtException', (error) => crashed('uncaughtException', error))
  process.on('unhandledRejection', (reason) => crashed('unhandledRejection', reason))
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) {
    process.on(signal, () => {
      write('signal', { signal })
      finish(0)
    })
  }
  process.on('exit', (code) => write('exit', { code }))
}

export async function runDesktopJoinCli(args: string[]): Promise<void> {
  const lifecycle: JoinLifecycle = { phase: 'starting' }
  installTerminationLogging(lifecycle)
  let stdin = ''
  if (!process.stdin.isTTY) {
    stdin = await new Promise((resolve) => {
      let data = ''
      process.stdin.setEncoding('utf8')
      process.stdin.on('data', (chunk) => {
        data += String(chunk)
      })
      process.stdin.on('end', () => resolve(data))
      process.stdin.on('error', () => resolve(''))
    })
  }
  const fromStdin = stdin.trim().length > 0 ? readHookStdinIds(stdin) : {}
  const fromArgs = parseDesktopJoinArgs(args)
  const outcome = await runDesktopJoin(
    {
      ...fromArgs,
      ...(fromStdin.threadId !== undefined && args.indexOf('--thread') === -1
        ? { threadId: fromStdin.threadId }
        : {}),
      ...(fromStdin.rolloutPath !== undefined && args.indexOf('--rollout') === -1
        ? { rolloutPath: fromStdin.rolloutPath }
        : {}),
      ...(fromStdin.workspaceCwd !== undefined && args.indexOf('--cwd') === -1
        ? { workspaceCwd: fromStdin.workspaceCwd }
        : {}),
      ...(fromStdin.source !== undefined ? { hookSource: fromStdin.source } : {}),
    },
    { lifecycle }
  )
  // Not serving: give the door back and close a socket that never joined.
  lifecycle.release?.()
  await lifecycle.closeBroker?.().catch(() => {})
  process.exit(outcome.exit)
}

export function desktopJoinUsage(): string {
  return 'Usage: harness-broker desktop-join --thread <id> [--rollout <path> --cwd <dir> --codex-home <dir> --hrc-socket <path> --source <hook> --deadline-ms <ms>]'
}
