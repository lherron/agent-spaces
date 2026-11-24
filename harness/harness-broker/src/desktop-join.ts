import { appendFileSync, mkdirSync, rmSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { JoinPrepareInput } from 'spaces-hrc-join-client'
import type { ParticipantAdapter } from 'spaces-runtime-contracts'
import { claimBrokerPid, releaseBrokerPid } from './desktop-join-pid-claim.js'
import { chooseScopeAndJoin } from './desktop-join-scope.js'
import {
  type DesktopJoinLog,
  type DesktopStatePaths,
  type JoinedRecord,
  priorCandidateScope,
  priorRespawn,
  probeBrokerSocket,
  readEndedRecord,
  readPriorJoin,
  reapStaleSiblingSockets,
  writeEndedRecord,
  writeJoinCandidate,
  writeJoinLog,
  writeJoinedRecords,
} from './desktop-join-thread.js'
import {
  type WrkqRegistryProject,
  desktopHostIncarnationId,
  readRegistryWithLastGood,
  resolveDesktopProject,
} from './desktop-project.js'
import type { Driver } from './drivers/driver.js'
import { assertSocketPathWithinBudget } from './socket-path.js'
import { serveUnixBroker } from './unix-broker.js'

export type DesktopJoinInput = {
  hrcSocketPath: string
  hookSource?: string | undefined
  projectRoot?: string | undefined
  registryProjects?: readonly WrkqRegistryProject[] | undefined
  agentsRoot?: string | undefined
  /** Join deadline; defaults to DEFAULT_JOIN_DEADLINE_MS. */
  deadlineMs?: number | undefined
}

type DesktopAdmission =
  | {
      admitted: true
      preparation: JoinPrepareInput['preparation']
      participantKey: string
      workspaceCwd: string
      homeIdentity: string
    }
  | { admitted: false; reason: string }

export type DesktopJoinClient = {
  sessionId: string
  classId: string
  agentId: string
  fallbackProjectId?: string
  cacheIdentity: Record<string, string>
  statePaths(): DesktopStatePaths
  adapter: ParticipantAdapter
  scopeRefs(projectId: string): Iterable<string>
  createDriver(session: DesktopSessionHooks): Driver
  admit(paths: DesktopStatePaths): Promise<DesktopAdmission>
  onJoined?(paths: DesktopStatePaths, joined: JoinedRecord): Promise<void>
}

/** A driver that watches its own session reports the session's end here (T-14467). */
export type DesktopSessionEnd = {
  reason: string
  detail: Record<string, unknown>
  invocationId: string
  /** The `invocation.exited` seq; HRC has recorded the exit once its ack reaches it. */
  exitedSeq: number
}

export type DesktopSessionHooks = {
  sessionEnded(end: DesktopSessionEnd): void
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
  | 'ending'

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
  /** Ends the process after a session-end teardown; defaults to `process.exit`. */
  exit?: ((code: number) => void) | undefined
  /** How long a session end waits for HRC to ack `invocation.exited`. */
  exitAckTimeoutMs?: number | undefined
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
const MAX_BACKOFF_MS = 5_000
/**
 * How long a session end waits for HRC's ack of `invocation.exited`. A
 * detached HRC that reattaches inside it replays the event and acks.
 */
export const DEFAULT_EXIT_ACK_TIMEOUT_MS = 60_000
/**
 * HRC acks an event once it is projected, then marks the runtime terminated.
 * Keep the transport open this long after the ack so that mark is not raced
 * by HRC seeing the transport close.
 */
const EXIT_SETTLE_MS = 1_000

/** Highest acked seq per invocation, with waiters for a seq to be reached. */
function ackTracker() {
  const acked = new Map<string, number>()
  const waiters = new Set<{ invocationId: string; seq: number; resolve: () => void }>()
  return {
    note({ invocationId, ackedThroughSeq }: { invocationId: string; ackedThroughSeq: number }) {
      acked.set(invocationId, Math.max(acked.get(invocationId) ?? 0, ackedThroughSeq))
      for (const waiter of waiters) {
        if (waiter.invocationId === invocationId && ackedThroughSeq >= waiter.seq) {
          waiters.delete(waiter)
          waiter.resolve()
        }
      }
    },
    reached(invocationId: string, seq: number, timeoutMs: number): Promise<boolean> {
      if ((acked.get(invocationId) ?? 0) >= seq) return Promise.resolve(true)
      return new Promise((resolveReached) => {
        const waiter = {
          invocationId,
          seq,
          resolve: () => {
            clearTimeout(timer)
            resolveReached(true)
          },
        }
        const timer = setTimeout(() => {
          waiters.delete(waiter)
          resolveReached(false)
        }, timeoutMs)
        waiters.add(waiter)
      })
    },
  }
}

function backoffMs(attempt: number): number {
  return Math.min(MAX_BACKOFF_MS, 500 * 2 ** (attempt - 1))
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms)))

/**
 * Retry a transient step with backoff inside the join deadline. Each failure
 * logs `event` with whether another attempt fits; returns undefined once the
 * deadline leaves no room for the next wait.
 */
async function retryWithinDeadline<T>(
  event: string,
  step: () => Promise<{ value: T } | { error: string }>,
  remainingMs: () => number,
  log: DesktopJoinLog
): Promise<T | undefined> {
  for (let attempt = 1; ; attempt += 1) {
    const result = await step()
    if ('value' in result) return result.value
    const waitMs = backoffMs(attempt)
    const retryable = remainingMs() > waitMs
    log(event, {
      message: result.error,
      attempt,
      retryable,
      ...(retryable ? { nextRetryMs: waitMs } : {}),
    })
    if (!retryable) return undefined
    await sleep(waitMs)
  }
}

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
  client: DesktopJoinClient,
  input: DesktopJoinInput,
  deps: DesktopJoinDeps = {}
): Promise<DesktopJoinOutcome> {
  const startedAt = Date.now()
  const paths = client.statePaths()
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

  const acks = ackTracker()
  let ending: Promise<void> | undefined
  /**
   * The session ended (T-14467): the driver has emitted `invocation.exited`.
   * Once HRC acks it, HRC has recorded the exit and this session's state is
   * removed. Without an ack the state stays for the joining hook's sweep.
   * Either way broker.pid is released and the process exits.
   */
  const endSession = async (end: DesktopSessionEnd): Promise<void> => {
    lifecycle.phase = 'ending'
    clearTimeout(deadlineTimer)
    log('session-ended', {
      reason: end.reason,
      ...end.detail,
      invocationId: end.invocationId,
      exitedSeq: end.exitedSeq,
    })
    const ackTimeoutMs = deps.exitAckTimeoutMs ?? DEFAULT_EXIT_ACK_TIMEOUT_MS
    const recorded = await acks.reached(end.invocationId, end.exitedSeq, ackTimeoutMs)
    if (recorded) await sleep(EXIT_SETTLE_MS)
    log(recorded ? 'exit-recorded' : 'exit-unacknowledged', {
      exitedSeq: end.exitedSeq,
      ...(recorded ? {} : { ackTimeoutMs }),
    })
    await lifecycle.closeBroker?.().catch(() => {})
    lifecycle.release?.()
    const keptBinding = recorded && writeEndedRecord(paths)
    if (recorded) {
      try {
        rmSync(paths.stateDir, { recursive: true, force: true })
        rmSync(paths.scopeCacheFile, { force: true })
      } catch {}
      // Every later join.log line (the CLI's `exit`) would recreate the dir.
      lifecycle.log = () => {}
    }
    // join.log went with the state dir: one line survives it.
    try {
      const endedLog = join(dirname(dirname(paths.stateDir)), 'hrc-desktop-ended.log')
      appendFileSync(
        endedLog,
        `${JSON.stringify({
          at: new Date().toISOString(),
          pid: process.pid,
          sessionId: client.sessionId,
          reason: end.reason,
          invocationId: end.invocationId,
          exitedSeq: end.exitedSeq,
          recorded,
          stateRemoved: recorded,
          keptBinding,
        })}\n`,
        { mode: 0o600 }
      )
    } catch {}
    ;(deps.exit ?? process.exit)(0)
  }
  const sessionHooks: DesktopSessionHooks = {
    sessionEnded(end) {
      ending ??= endSession(end).catch((error) => {
        log('session-end-failed', { message: errorMessage(error) })
        lifecycle.release?.()
        ;(deps.exit ?? process.exit)(0)
      })
    },
  }

  try {
    lifecycle.phase = 'admitting'
    const admission = await client.admit(paths)
    if (!admission.admitted) {
      log('not-admitted', { reason: admission.reason, source: input.hookSource ?? 'unknown' })
      return { exit: 0, reason: `not-admitted:${admission.reason}` }
    }

    lifecycle.phase = 'claiming'
    mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 })
    const claim = claimBrokerPid(paths, client.sessionId, deadlineMs + STALLED_HOLDER_GRACE_MS, log)
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

    const reaped = reapStaleSiblingSockets(paths.stateDir)
    if (reaped.length > 0) {
      log('reaped-stale-sockets', { sockets: reaped })
    }

    // A session resumed after a clean end has no join.json, only its ended record.
    const priorJoin = readPriorJoin(paths.joinFile)
    const resumedFromEnded = priorJoin === undefined ? readEndedRecord(paths.endedFile) : undefined
    const prior = priorJoin ?? resumedFromEnded
    if (prior?.livePid !== undefined) {
      log('already-serving', { holderPid: prior.livePid, via: 'join.json' })
      return { exit: 0, reason: 'already-serving' }
    }
    if (prior?.socketPath !== undefined && (await probeBrokerSocket(prior.socketPath))) {
      log('already-serving', { socketPath: prior.socketPath })
      return { exit: 0, reason: 'already-serving' }
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
      const registryProjects =
        input.registryProjects ??
        (await retryWithinDeadline(
          'registry-unavailable',
          async () => {
            const registry = await readRegistryWithLastGood(
              paths.registryCacheFile,
              Math.min(registryTimeoutMs, Math.max(1, remainingMs())),
              log
            )
            return 'projects' in registry ? { value: registry.projects } : registry
          },
          remainingMs,
          log
        ))
      if (registryProjects === undefined) return expire()
      project = await resolveDesktopProject({
        workspaceCwd: admission.workspaceCwd,
        registryProjects,
        ...(input.agentsRoot === undefined ? {} : { agentsRoot: input.agentsRoot }),
      })
    }
    if (!('bound' in project) && client.fallbackProjectId !== undefined) {
      project = {
        bound: {
          projectId: client.fallbackProjectId,
          projectRoot: admission.workspaceCwd,
          resolvedBy: 'fallback',
        },
      }
    }
    if (!('bound' in project)) {
      log('no-project', { reason: project.reason, detail: project.detail })
      return { exit: 0, reason: `no-project:${project.reason}` }
    }

    const hostIncarnationId = desktopHostIncarnationId(admission.homeIdentity, client.sessionId)
    const socketPath = join(paths.stateDir, `broker-${process.pid}.sock`)
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
        desktopDriver: () => client.createDriver(sessionHooks),
        participantBootstrap: true,
        onEventsAcked: acks.note,
        // HRC's controller reattach replays events (eventsSince) and acks them;
        // without a durable ledger both throw EventReplayUnavailable and the
        // runtime never leaves starting. The ledger lives in the thread dir so
        // a respawn replays rather than re-emits pre-kill turns.
        ledgerPath: join(paths.stateDir, 'event-ledger.sqlite'),
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

    let resumeFromScope = priorCandidateScope(prior, hostIncarnationId)

    const writeCandidate = (scopeRef: string): void => {
      // A retry after a lost register reply resumes at the same address,
      // where the same-incarnation register replays.
      resumeFromScope = scopeRef
      writeJoinCandidate(paths.joinFile, { scopeRef, hostIncarnationId })
    }

    const respawn = priorRespawn(prior, hostIncarnationId)

    lifecycle.phase = 'registering'
    const outcome = await retryWithinDeadline(
      'join-transport-error',
      async () => {
        try {
          return {
            value: await chooseScopeAndJoin({
              hrcSocketPath: input.hrcSocketPath,
              scopeRefs: client.scopeRefs(project.bound.projectId),
              hostIncarnationId,
              socketPath,
              classId: client.classId,
              adapter: client.adapter,
              participantKey: admission.participantKey,
              workspaceCwd: admission.workspaceCwd,
              preparation: admission.preparation,
              ...(respawn === undefined ? {} : respawn),
              ...(resumeFromScope === undefined ? {} : { resumeFromScope }),
              onCandidateScope: writeCandidate,
              requestTimeoutMs: Math.min(requestTimeoutMs, Math.max(1, remainingMs())),
            }),
          }
        } catch (error) {
          return { error: errorMessage(error) }
        }
      },
      remainingMs,
      log
    )
    if (outcome === undefined) return expire()

    if (outcome.exit !== 'joined') {
      log('join-refused', { ...outcome })
      return { exit: 0, reason: `join-${outcome.exit}` }
    }

    const joined = {
      registrationId: outcome.registrationId,
      attemptId: outcome.attemptId,
      attachEpoch: outcome.attachEpoch,
      hostIncarnationId,
      runtimeId: outcome.runtimeId,
      generation: outcome.generation,
      scopeRef: outcome.scopeRef,
      socketPath,
    }
    writeJoinedRecords(paths, joined, {
      projectId: project.bound.projectId,
      agentId: client.agentId,
      identity: client.cacheIdentity,
      projectRoot: admission.workspaceCwd,
    })
    if (resumedFromEnded !== undefined) rmSync(paths.endedFile, { force: true })
    if (ending === undefined) lifecycle.phase = 'joined'
    clearTimeout(deadlineTimer)
    try {
      await client.onJoined?.(paths, joined)
    } catch (error) {
      log('post-join-setup-failed', { message: errorMessage(error) })
    }
    log('joined', {
      scopeRef: outcome.scopeRef,
      registrationId: outcome.registrationId,
      attachEpoch: outcome.attachEpoch,
      respawn: respawn !== undefined,
      ...(resumedFromEnded !== undefined ? { fromEndedRecord: true } : {}),
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
