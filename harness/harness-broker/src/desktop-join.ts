import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  type CodexDesktopParticipantPreparation,
  createCodexDesktopParticipantAdapter,
} from 'agent-spaces'
import { claimBrokerPid, releaseBrokerPid } from './desktop-join-pid-claim.js'
import { chooseScopeAndJoin } from './desktop-join-scope.js'
import {
  type DesktopJoinLog,
  priorCandidateScope,
  priorRespawn,
  probeBrokerSocket,
  readPriorJoin,
  reapStaleSiblingSockets,
  threadPaths,
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

    const prior = readPriorJoin(paths.joinFile)
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
              join(input.codexHome, REGISTRY_CACHE_FILE),
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

    writeJoinedRecords(
      paths,
      {
        registrationId: outcome.registrationId,
        attemptId: outcome.attemptId,
        attachEpoch: outcome.attachEpoch,
        hostIncarnationId,
        runtimeId: outcome.runtimeId,
        generation: outcome.generation,
        scopeRef: outcome.scopeRef,
        socketPath,
      },
      {
        projectId: project.bound.projectId,
        threadId: input.threadId,
        projectRoot: admission.workspaceCwd,
      }
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
