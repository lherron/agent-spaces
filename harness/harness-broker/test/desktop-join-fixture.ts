/**
 * Shared fixture for the `desktop-join` CLI handler tests: a scratch Codex
 * home with a real rollout, a stub HRC participant socket, and
 * `runDesktopJoin` driven with an injected `serve` so nothing binds.
 * What a test observes is what a caller can: the register requests HRC saw,
 * the outcome, join.log, join.json and the scope cache.
 */
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type DesktopThreadPaths, threadPaths } from '../src/desktop-join-thread.js'
import {
  type DesktopJoinInput,
  type DesktopJoinOutcome,
  admitDesktopThread,
  runDesktopJoin,
} from '../src/desktop-join.js'
import { desktopHostIncarnationId } from '../src/desktop-project.js'

export const THREAD_ID = '0199abcd-1234-5678-9abc-def012345678'

export type StubReply = { status: number; body: unknown }
export type StubRequest = { path: string; body: any }

const fixtureDirs: string[] = []

/** Remove every fixture directory created since the last call. */
export async function cleanupDesktopJoinFixtures(): Promise<void> {
  await Promise.all(fixtureDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
}

export function stubHrc(handler: (path: string, body: any) => StubReply) {
  const sock = join(tmpdir(), `stub-hrc-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  const server = Bun.serve({
    unix: sock,
    async fetch(request) {
      const url = new URL(request.url)
      const body = await request.json().catch(() => undefined)
      const { status, body: response } = handler(url.pathname, body)
      return Response.json(response, { status })
    },
  })
  return { sock, stop: () => server.stop() }
}

export type DesktopJoinFixture = {
  dir: string
  codexHome: string
  rolloutPath: string
  bundle: string
  workspace: string
  paths: DesktopThreadPaths
}

/**
 * A Codex home under a short /tmp path (the per-thread broker socket must fit
 * sockaddr_un) with one rollout whose `thread_source` decides admission and
 * whose cwd is `workspace` (relative to the fixture dir; created).
 */
export async function desktopJoinFixture(
  options: { threadSource?: 'user' | 'spawning-subagent'; workspace?: string } = {}
): Promise<DesktopJoinFixture> {
  const dir = await mkdtemp('/tmp/djx-')
  fixtureDirs.push(dir)
  const codexHome = join(dir, 'codex-home')
  const rolloutDir = join(codexHome, 'sessions')
  mkdirSync(rolloutDir, { recursive: true })
  const workspace = join(dir, options.workspace ?? 'workspace')
  mkdirSync(workspace, { recursive: true })
  const rolloutPath = join(rolloutDir, `${THREAD_ID}.jsonl`)
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: THREAD_ID,
        source: 'vscode',
        thread_source: options.threadSource ?? 'user',
        originator: 'codex-desktop',
        cwd: workspace,
      },
    })}\n`
  )
  const bundle = join(dir, 'codex-bundle')
  await writeFile(bundle, '#!/bin/sh\n')
  return {
    dir,
    codexHome,
    rolloutPath,
    bundle,
    workspace,
    paths: threadPaths(codexHome, THREAD_ID),
  }
}

/** The host incarnation runDesktopJoin derives for this fixture's thread. */
export async function fixtureIncarnation(fixture: DesktopJoinFixture): Promise<string> {
  const admission = await admitDesktopThread({
    threadId: THREAD_ID,
    codexHome: fixture.codexHome,
    rolloutPath: fixture.rolloutPath,
    workspaceCwd: fixture.workspace,
    fallbackHomeDir: fixture.dir,
    reportedBundleExecutable: fixture.bundle,
    projectRoot: fixture.workspace,
    nativeAttemptStorePath: join(fixture.dir, 'attempts.db'),
  })
  if (!admission.admitted) throw new Error('fixture was not admitted')
  return desktopHostIncarnationId(admission.homeIdentity, THREAD_ID)
}

/** Seed join.json in the thread dir, as a previous run would have left it. */
export async function seedJoinFile(
  fixture: DesktopJoinFixture,
  record: Record<string, unknown>
): Promise<void> {
  mkdirSync(fixture.paths.threadDir, { recursive: true, mode: 0o700 })
  await writeFile(fixture.paths.joinFile, JSON.stringify(record))
}

export const registered = (scopeRef: string): StubReply => ({
  status: 200,
  body: {
    status: 'registered',
    scopeRef,
    hostSessionId: 'hs_1',
    generation: 1,
    created: true,
    resumed: false,
    observation: { state: 'attachment_pending', detail: 'ok' },
    identity: {
      registrationId: 'reg_1',
      laneRef: 'main',
      runtimeId: 'rt_1',
      attemptId: 'att_1',
      invocationId: 'inv_1',
      attachEpoch: 1,
      requestId: 'req_1',
      operationId: 'op_1',
    },
  },
})

export const attached: StubReply = {
  status: 200,
  body: {
    status: 'attached',
    registrationId: 'reg_1',
    attemptId: 'att_1',
    attachEpoch: 1,
    prepared: true,
    observation: { state: 'attached', detail: 'ok' },
  },
}

export const occupied: StubReply = {
  status: 409,
  body: { status: 'rejected', reason: 'participant_scope_occupied', detail: 'held' },
}

/** The exact envelope live HRC returns for a scope this node permanently retired (2026-09-26). */
export const retiredRefusal = (scopeRef: string): StubReply => ({
  status: 409,
  body: {
    error: {
      code: 'stale_context',
      message: `${scopeRef} is permanently retired on max3; establish it fresh on another node after the shared binding is absent.`,
      detail: { scopeRef, path: 'resolve-session', reason: 'scope-retired', retryable: false },
    },
  },
})

export type DesktopJoinRun = {
  outcome: DesktopJoinOutcome
  /** requestedSessionRef of every register HRC saw, in order. */
  registered: string[]
  requests: StubRequest[]
  served: Record<string, unknown> | undefined
}

/**
 * Run the desktop-join handler against a stub HRC. `register` answers each
 * register request by scope ref; attach requests are answered `attached`.
 */
export async function runJoin(
  fixture: DesktopJoinFixture,
  register: (scopeRef: string, body: any) => StubReply,
  overrides: Partial<DesktopJoinInput> = {}
): Promise<DesktopJoinRun> {
  const requests: StubRequest[] = []
  const seen: string[] = []
  const { sock, stop } = stubHrc((path, body) => {
    requests.push({ path, body })
    if (path !== '/v1/participants/register') return attached
    const scopeRef = body.requestedSessionRef as string
    seen.push(scopeRef)
    return register(scopeRef, body)
  })
  let served: Record<string, unknown> | undefined
  try {
    const outcome = await runDesktopJoin(
      {
        threadId: THREAD_ID,
        codexHome: fixture.codexHome,
        rolloutPath: fixture.rolloutPath,
        hrcSocketPath: sock,
        projectRoot: fixture.workspace,
        reportedBundleExecutable: fixture.bundle,
        ...overrides,
      },
      {
        serve: (async (options: Record<string, unknown>) => {
          served = options
          return { broker: {}, socketPath: 'x', close: async () => {} }
        }) as never,
        blockForever: (async () => {}) as never,
        onDeadline: () => {},
      }
    )
    return { outcome, registered: seen, requests, served }
  } finally {
    stop()
  }
}

/** join.log lines with the given event name. */
export function joinLogEvents(
  fixture: DesktopJoinFixture,
  event: string
): Record<string, unknown>[] {
  let text = ''
  try {
    text = readFileSync(fixture.paths.joinLog, 'utf8')
  } catch {
    return []
  }
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line['event'] === event)
}

/** The address cache the overlay's PreToolUse hook reads after a join. */
export function scopeCache(fixture: DesktopJoinFixture): Record<string, unknown> {
  return JSON.parse(readFileSync(fixture.paths.scopeCacheFile, 'utf8')) as Record<string, unknown>
}
