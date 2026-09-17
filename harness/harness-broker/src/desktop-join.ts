import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  registerParticipant,
} from 'spaces-hrc-join-client'
import type { ParticipantAdapter } from 'spaces-runtime-contracts'
import { serveUnixBroker } from './cli.js'
import {
  DESKTOP_AGENT_ID,
  DESKTOP_LANE_REF,
  type WrkqRegistryProject,
  desktopHostIncarnationId,
  desktopScopeRef,
  desktopSlotTokenSequence,
  resolveDesktopProject,
} from './desktop-project.js'
import { assertSocketPathWithinBudget } from './socket-path.js'

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
  let examined = 0
  let scopeRef = next()
  while (scopeRef !== undefined) {
    tried.add(scopeRef)
    examined += 1
    input.onCandidateScope?.(scopeRef)
    const register = await registerParticipant(input.hrcSocketPath, {
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
    })
    if (register.outcome !== 'registered') {
      if (register.outcome === 'pending') {
        return { exit: 'pending-hold', scopeRef, reason: register.reason, detail: register.detail }
      }
      if (isScopeOccupied(register) || isHostBindingConflict(register)) {
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
    const attach = await attachParticipant(input.hrcSocketPath, {
      registrationId: register.identity.registrationId,
      attemptId: register.identity.attemptId,
      attachEpoch: register.identity.attachEpoch,
      socketPath: input.socketPath,
      profile: prepared.profile,
    })
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
  appendFileSync(
    joinLog,
    `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...detail })}\n`
  )
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
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

export type DesktopJoinDeps = {
  serve?: typeof serveUnixBroker | undefined
  blockForever?: (() => Promise<never>) | undefined
}

/**
 * `harness-broker desktop-join`: hook-started self-join for one Desktop thread.
 * Every non-serving path exits 0 with a typed reason in join.log — a missed
 * join is normal state (subagent thread, daemon restarting), never a hook
 * failure. Only malformed input exits 1.
 */
export async function runDesktopJoin(
  input: DesktopJoinInput,
  deps: DesktopJoinDeps = {}
): Promise<DesktopJoinOutcome> {
  const paths = threadPaths(input.codexHome, input.threadId)
  const log: DesktopJoinLog = (event, detail) => writeJoinLog(paths.joinLog, event, detail)

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

  mkdirSync(paths.threadDir, { recursive: true, mode: 0o700 })
  try {
    writeFileSync(paths.pidFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code !== 'EEXIST') throw error
    const existing = Number(readFileSync(paths.pidFile, 'utf8').trim())
    if (Number.isInteger(existing) && processAlive(existing)) {
      log('already-serving', { pid: existing })
      return { exit: 0, reason: 'already-serving' }
    }
    writeFileSync(paths.pidFile, `${process.pid}\n`, { mode: 0o600 })
  }

  const prior = readJoinFile(paths.joinFile)
  if (prior !== undefined) {
    const priorPid = typeof prior['pid'] === 'number' ? (prior['pid'] as number) : undefined
    if (priorPid !== undefined && priorPid !== process.pid && processAlive(priorPid)) {
      log('already-serving', { pid: priorPid, via: 'join.json' })
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

  const project =
    input.projectRoot !== undefined
      ? {
          bound: {
            projectId: basenameOf(input.projectRoot),
            projectRoot: input.projectRoot,
            resolvedBy: 'override',
          },
        }
      : await resolveDesktopProject({
          workspaceCwd: admission.workspaceCwd,
          ...(input.registryProjects === undefined
            ? {}
            : { registryProjects: input.registryProjects }),
          ...(input.agentsRoot === undefined ? {} : { agentsRoot: input.agentsRoot }),
        })
  if (!('bound' in project)) {
    log('no-project', { reason: project.reason, detail: project.detail })
    return { exit: 0, reason: `no-project:${project.reason}` }
  }

  const hostIncarnationId = desktopHostIncarnationId(admission.homeIdentity, input.threadId)
  const socketPath = join(paths.threadDir, `broker-${process.pid}.sock`)
  try {
    assertSocketPathWithinBudget(socketPath)
  } catch (error) {
    log('socket-path-over-budget', {
      message: error instanceof Error ? error.message : String(error),
    })
    return { exit: 0, reason: 'socket-path-over-budget' }
  }

  const serve = deps.serve ?? serveUnixBroker
  let closeBroker: (() => Promise<void>) | undefined
  try {
    const served = await serve({
      socketPath,
      cliOptions: {},
      participantBootstrap: true,
      onServerError: (error) => {
        writeJoinLog(paths.joinLog, 'server-error', { message: error.message })
      },
    })
    closeBroker = served.close
  } catch (error) {
    log('serve-failed', { message: error instanceof Error ? error.message : String(error) })
    return { exit: 0, reason: 'serve-failed' }
  }
  // Serve until killed: release the socket and ledger handles on a clean
  // signal so a SIGTERM respawn starts from a dead socket, not a stale file.
  // A kill -9 skips this; the next hook's liveness probe covers that path.
  const shutdown = (): void => {
    void Promise.resolve()
      .then(() => closeBroker?.())
      .catch(() => {})
      .then(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  // Write-ahead resume (component 3(v), primary): a previous run persisted
  // its candidate scope with phase 'registering' before calling register. Resume
  // the loop there instead of restarting at primary-nova, so a crash between
  // register and completion converges without parsing refusal text.
  const writeAhead =
    prior !== undefined &&
    prior['phase'] === 'registering' &&
    typeof prior['candidateScope'] === 'string' &&
    prior['hostIncarnationId'] === hostIncarnationId
      ? { resumeFromScope: prior['candidateScope'] as string }
      : undefined

  const writeCandidate = (scopeRef: string): void => {
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

  let outcome: Awaited<ReturnType<typeof chooseScopeAndJoin>>
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
      ...(writeAhead === undefined ? {} : writeAhead),
      onCandidateScope: writeCandidate,
    })
  } catch (error) {
    log('join-transport-error', { message: error instanceof Error ? error.message : String(error) })
    return { exit: 0, reason: 'join-transport-error' }
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
  log('joined', {
    scopeRef: outcome.scopeRef,
    registrationId: outcome.registrationId,
    attachEpoch: outcome.attachEpoch,
    respawn: respawn !== undefined,
  })

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
      'Usage: harness-broker desktop-join --thread <id> [--rollout <path> --cwd <dir> --codex-home <dir> --hrc-socket <path> --source <hook>]'
    )
  }
  const rolloutPath = flag('--rollout')
  const workspaceCwd = flag('--cwd')
  return {
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

export async function runDesktopJoinCli(args: string[]): Promise<void> {
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
  const outcome = await runDesktopJoin({
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
  })
  process.exit(outcome.exit)
}

export function desktopJoinUsage(): string {
  return 'Usage: harness-broker desktop-join --thread <id> [--rollout <path> --cwd <dir> --codex-home <dir> --hrc-socket <path> --source <hook>]'
}
