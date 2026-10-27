import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  cleanupDesktopJoinFixtures,
  desktopJoinFixture,
  fixtureIncarnation,
  joinLogEvents,
  occupied,
  registered,
  retiredRefusal,
  runJoin,
  scopeCache,
  seedJoinFile,
  stubHrc,
} from './desktop-join-fixture'

afterEach(cleanupDesktopJoinFixtures)

// runDesktopJoin with an explicit projectRoot binds the project named by its basename.
const scope = (slot: string) => `agent:stella:project:workspace:task:${slot}`
const NOVA = scope('primary-nova')
const COMET = scope('primary-comet')
const PULSAR = scope('primary-pulsar')

const registerPaths = (requests: { path: string }[]) => requests.map((request) => request.path)

describe('desktop-join admission', () => {
  test('a subagent-shaped rollout is not admitted: logged reason, no broker served, no HRC request', async () => {
    const fixture = await desktopJoinFixture({ threadSource: 'spawning-subagent' })
    const run = await runJoin(fixture, () => {
      throw new Error('a subagent thread must never register')
    })

    expect(run.outcome.exit).toBe(0)
    expect(run.outcome.reason).toMatch(/^not-admitted:codex_desktop_/)
    expect(run.served).toBeUndefined()
    expect(run.requests).toEqual([])
    expect(joinLogEvents(fixture, 'not-admitted')).toEqual([
      expect.objectContaining({ reason: run.outcome.reason.slice('not-admitted:'.length) }),
    ])
  })
})

describe('desktop-join scope loop', () => {
  test('an occupied slot advances to the next one and the thread joins the first free slot', async () => {
    const fixture = await desktopJoinFixture()
    const run = await runJoin(fixture, (scopeRef) =>
      scopeRef === NOVA ? occupied : registered(scopeRef)
    )

    expect(run.registered).toEqual([NOVA, COMET])
    expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(scopeCache(fixture)).toMatchObject({ scopeRef: COMET, slotToken: 'primary-comet' })
  })

  test.each([
    {
      refusal: 'participant_scope_bound_elsewhere redirects',
      reply: {
        status: 409,
        body: {
          status: 'rejected',
          reason: 'participant_scope_bound_elsewhere',
          detail: 'elsewhere',
          observed: { homeNodeId: 'node-b' },
        },
      },
      reason: 'join-redirect',
      logged: {
        exit: 'redirect',
        reason: 'participant_scope_bound_elsewhere',
        homeNodeId: 'node-b',
      },
    },
    {
      refusal: 'a pending register holds',
      reply: {
        status: 200,
        body: { status: 'pending', reason: 'host_retirement_unproven', detail: 'hold' },
      },
      reason: 'join-pending-hold',
      logged: { exit: 'pending-hold', reason: 'host_retirement_unproven' },
    },
  ])(
    '$refusal at primary-nova without advancing and never attaches',
    async ({ reply, reason, logged }) => {
      const fixture = await desktopJoinFixture()
      const run = await runJoin(fixture, () => reply)

      expect(run.registered).toEqual([NOVA])
      expect(registerPaths(run.requests)).toEqual(['/v1/participants/register'])
      expect(run.outcome).toEqual({ exit: 0, reason })
      expect(joinLogEvents(fixture, 'join-refused')).toEqual([
        expect.objectContaining({ ...logged, scopeRef: NOVA }),
      ])
      expect(existsSync(fixture.paths.scopeCacheFile)).toBe(false)
    }
  )

  test('participant_host_incarnation_bound_elsewhere jumps to the held address and replays the join there', async () => {
    const fixture = await desktopJoinFixture()
    const run = await runJoin(fixture, (scopeRef) =>
      scopeRef === COMET
        ? registered(scopeRef)
        : {
            status: 409,
            body: {
              status: 'rejected',
              reason: 'participant_host_incarnation_bound_elsewhere',
              detail: `host incarnation host-incarnation:test already holds ${COMET}; one incarnation holds at most one address`,
            },
          }
    )

    expect(run.registered).toEqual([NOVA, COMET])
    expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(scopeCache(fixture)).toMatchObject({ scopeRef: COMET })
  })
})

describe('desktop-join retired slots', () => {
  test('a retired slot advances to the next one instead of ending the join', async () => {
    // Incident 2026-09-26: the loop stopped on retired primary-quasar, the
    // thread kept its provisional codex-<uuid> address, and mail to that
    // address cold-birthed a codex CLI seat.
    const fixture = await desktopJoinFixture()
    const run = await runJoin(fixture, (scopeRef) => {
      if (scopeRef === NOVA) return occupied
      if (scopeRef === COMET) return retiredRefusal(scopeRef)
      return registered(scopeRef)
    })

    expect(run.registered).toEqual([NOVA, COMET, PULSAR])
    expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(scopeCache(fixture)).toMatchObject({ scopeRef: PULSAR })
  })

  test('a retired write-ahead candidate falls back to the slot sequence from primary-nova', async () => {
    const fixture = await desktopJoinFixture()
    await seedJoinFile(fixture, {
      phase: 'registering',
      candidateScope: COMET,
      hostIncarnationId: await fixtureIncarnation(fixture),
    })
    const run = await runJoin(fixture, (scopeRef) =>
      scopeRef === COMET ? retiredRefusal(scopeRef) : registered(scopeRef)
    )

    expect(run.registered).toEqual([COMET, NOVA])
    expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
    expect(scopeCache(fixture)).toMatchObject({ scopeRef: NOVA })
  })

  test('a pinned respawn address that is retired refuses with hrc_stale_context instead of advancing', async () => {
    const fixture = await desktopJoinFixture()
    const incarnation = await fixtureIncarnation(fixture)
    await seedJoinFile(fixture, {
      phase: 'joined',
      registrationId: 'reg_prev',
      runtimeId: 'rt_prev',
      generation: 4,
      scopeRef: COMET,
      hostIncarnationId: incarnation,
    })
    const run = await runJoin(fixture, (scopeRef) => retiredRefusal(scopeRef))

    expect(run.registered).toEqual([COMET])
    expect(run.requests[0]?.body.expectedPredecessor).toEqual({
      hostIncarnationId: incarnation,
      runtimeId: 'rt_prev',
      generation: 4,
    })
    expect(run.outcome).toEqual({ exit: 0, reason: 'join-register-refused' })
    expect(joinLogEvents(fixture, 'join-refused')).toEqual([
      expect.objectContaining({
        exit: 'register-refused',
        scopeRef: COMET,
        reason: 'hrc_stale_context',
      }),
    ])
  })

  test('a stale_context refusal other than scope-retired ends the join at the first slot', async () => {
    const fixture = await desktopJoinFixture()
    const run = await runJoin(fixture, (scopeRef) => ({
      status: 409,
      body: {
        error: {
          code: 'stale_context',
          message: 'pin mismatch',
          detail: { scopeRef, reason: 'pin-mismatch', retryable: false },
        },
      },
    }))

    expect(run.registered).toEqual([NOVA])
    expect(run.outcome).toEqual({ exit: 0, reason: 'join-register-refused' })
    expect(joinLogEvents(fixture, 'join-refused')).toEqual([
      expect.objectContaining({
        exit: 'register-refused',
        scopeRef: NOVA,
        reason: 'hrc_stale_context',
      }),
    ])
  })
})

describe('desktop-join write-ahead resume', () => {
  test('runDesktopJoin resumes a registering write-ahead instead of restarting at nova', async () => {
    const { runDesktopJoin, admitDesktopThread } = await import('../src/desktop-join.js')
    const { threadPaths } = await import('../src/desktop-join-thread.js')
    const { desktopHostIncarnationId } = await import('../src/desktop-project.js')
    const dir = await mkdtemp('/tmp/djr-')
    const codexHome = join(dir, 'codex-home')
    const rolloutDir = join(codexHome, 'sessions')
    mkdirSync(rolloutDir, { recursive: true })
    const threadId = '0199abcd-1234-5678-9abc-def012345678'
    const rolloutPath = join(rolloutDir, `${threadId}.jsonl`)
    await writeFile(
      rolloutPath,
      `${JSON.stringify({
        type: 'session_meta',
        payload: {
          session_id: threadId,
          source: 'vscode',
          thread_source: 'user',
          originator: 'codex-desktop',
          cwd: join(dir, 'workspace'),
        },
      })}\n`
    )
    const bundle = join(dir, 'codex-bundle')
    await writeFile(bundle, '#!/bin/sh\n')
    const admission = await admitDesktopThread({
      threadId,
      codexHome,
      rolloutPath,
      workspaceCwd: join(dir, 'workspace'),
      fallbackHomeDir: dir,
      reportedBundleExecutable: bundle,
      projectRoot: join(dir, 'workspace'),
      nativeAttemptStorePath: join(dir, 'attempts.db'),
    })
    if (!admission.admitted) throw new Error('fixture was not admitted')
    const incarnation = desktopHostIncarnationId(admission.homeIdentity, threadId)
    const paths = threadPaths(codexHome, threadId)
    mkdirSync(paths.threadDir, { recursive: true, mode: 0o700 })
    const HELD = 'agent:stella:project:demo:task:primary-comet'
    await writeFile(
      paths.joinFile,
      JSON.stringify({
        phase: 'registering',
        candidateScope: HELD,
        hostIncarnationId: incarnation,
        pid: 1,
      })
    )
    const seen: string[] = []
    const { sock, stop } = stubHrc((path, body) => {
      if (path === '/v1/participants/register') {
        seen.push((body as any).requestedSessionRef)
        return {
          status: 200,
          body: {
            status: 'registered',
            scopeRef: (body as any).requestedSessionRef,
            hostSessionId: 'hs_1',
            generation: 1,
            created: true,
            resumed: false,
            observation: { state: 'attachment_pending', detail: 'ok' },
            identity: {
              registrationId: 'reg_r',
              laneRef: 'main',
              runtimeId: 'rt_r',
              attemptId: 'att_r',
              invocationId: 'inv_r',
              attachEpoch: 1,
              requestId: 'req_r',
              operationId: 'op_r',
            },
          },
        }
      }
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_r',
          attemptId: 'att_r',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      let servedWith: Record<string, unknown> | undefined
      const outcome = await runDesktopJoin(
        {
          threadId,
          codexHome,
          rolloutPath,
          hrcSocketPath: sock,
          projectRoot: join(dir, 'workspace'),
          reportedBundleExecutable: bundle,
        },
        {
          serve: (async (options: Record<string, unknown>) => {
            servedWith = options
            return { broker: {}, socketPath: 'x', close: async () => {} }
          }) as never,
          blockForever: (async () => {}) as never,
        }
      )
      expect(servedWith?.['participantBootstrap']).toBe(true)
      expect(String(servedWith?.['ledgerPath'] ?? '')).toBe(
        join(paths.threadDir, 'event-ledger.sqlite')
      )
      expect(seen[0]).toBe(HELD)
      expect(outcome).toMatchObject({ exit: 0 })
      const written = JSON.parse(readFileSync(paths.joinFile, 'utf8'))
      expect(written.phase).toBe('joined')
      expect(written.scopeRef).toBe(HELD)
      const cache = JSON.parse(
        readFileSync(join(codexHome, 'hrc-desktop-scopes', `${threadId}.json`), 'utf8')
      )
      expect(cache).toMatchObject({
        scopeRef: HELD,
        agentId: 'stella',
        projectId: 'workspace',
        slotToken: 'primary-comet',
        laneRef: 'main',
      })
    } finally {
      stop()
    }
  })
})

describe('desktop-join stale socket reap', () => {
  test('runDesktopJoin reaps only dead-pid broker sockets at startup and keeps live sockets and other files', async () => {
    const fixture = await desktopJoinFixture()
    mkdirSync(fixture.paths.threadDir, { recursive: true, mode: 0o700 })
    const dead = join(fixture.paths.threadDir, 'broker-999999918.sock')
    // Hold a separate live process for the duration of the join.
    const child = spawn('sleep', ['30'])
    if (child.pid === undefined) throw new Error('failed to start live process fixture')
    const live = join(fixture.paths.threadDir, `broker-${child.pid}.sock`)
    const notASocket = join(fixture.paths.threadDir, 'broker-999999917.json')
    const nonNumeric = join(fixture.paths.threadDir, 'broker-abc.sock')
    try {
      for (const path of [dead, live, notASocket, nonNumeric]) await writeFile(path, '')

      const run = await runJoin(fixture, (scopeRef) => registered(scopeRef))

      expect(run.outcome).toEqual({ exit: 0, reason: 'serving' })
      expect(run.registered[0]).toBe(NOVA)
      expect(existsSync(dead)).toBe(false)
      expect(existsSync(live)).toBe(true)
      expect(existsSync(notASocket)).toBe(true)
      expect(existsSync(nonNumeric)).toBe(true)
      expect(existsSync(fixture.paths.joinFile)).toBe(true)
      expect(joinLogEvents(fixture, 'reaped-stale-sockets')).toEqual([
        expect.objectContaining({ sockets: ['broker-999999918.sock'] }),
      ])
    } finally {
      child.kill()
    }
  })
})
