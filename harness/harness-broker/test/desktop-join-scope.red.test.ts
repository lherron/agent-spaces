import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitDesktopThread, chooseScopeAndJoin } from '../src/desktop-join.js'

const THREAD_ID = '0199abcd-1234-5678-9abc-def012345678'

async function desktopHome(kind: 'user' | 'subagent') {
  const dir = await mkdtemp(join(tmpdir(), 'desktop-join-'))
  const codexHome = join(dir, 'codex-home')
  const rolloutDir = join(codexHome, 'sessions')
  await mkdir(rolloutDir, { recursive: true })
  const rolloutPath = join(rolloutDir, `${THREAD_ID}.jsonl`)
  await writeFile(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: THREAD_ID,
        source: 'vscode',
        thread_source: kind === 'user' ? 'user' : 'spawning-subagent',
        originator: 'codex-desktop',
        cwd: join(dir, 'workspace'),
      },
    })}\n`
  )
  const bundleExecutable = join(dir, 'codex-bundle')
  await writeFile(bundleExecutable, '#!/bin/sh\n')
  return { dir, codexHome, rolloutPath, bundleExecutable }
}

function stubHrc(handler: (path: string, body: any) => { status: number; body: unknown }) {
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

describe('desktop-join admission', () => {
  test('subagent-shaped rollout is refused with a logged reason, no broker', async () => {
    const home = await desktopHome('subagent')
    const outcome = await admitDesktopThread({
      threadId: THREAD_ID,
      codexHome: home.codexHome,
      rolloutPath: home.rolloutPath,
      workspaceCwd: join(home.dir, 'workspace'),
      fallbackHomeDir: home.dir,
      reportedBundleExecutable: home.bundleExecutable,
      projectRoot: join(home.dir, 'workspace'),
      nativeAttemptStorePath: join(home.dir, 'attempts.db'),
    })
    expect(outcome.admitted).toBe(false)
    expect(outcome.reason).toMatch(/codex_desktop_/)
  })

  test('user thread admits with preparation for the join', async () => {
    const home = await desktopHome('user')
    const outcome = await admitDesktopThread({
      threadId: THREAD_ID,
      codexHome: home.codexHome,
      rolloutPath: home.rolloutPath,
      workspaceCwd: join(home.dir, 'workspace'),
      fallbackHomeDir: home.dir,
      reportedBundleExecutable: home.bundleExecutable,
      projectRoot: join(home.dir, 'workspace'),
      nativeAttemptStorePath: join(home.dir, 'attempts.db'),
    })
    expect(outcome.admitted).toBe(true)
    if (!outcome.admitted) return
    expect(outcome.preparation.homeIdentity.length).toBeGreaterThan(0)
  })
})

describe('desktop-join scope loop', () => {
  test('advances past occupied slots and joins the first free one', async () => {
    const seen: string[] = []
    const { sock, stop } = stubHrc((path, body) => {
      if (path === '/v1/participants/register') {
        seen.push((body as any).requestedSessionRef)
        if (!(body as any).requestedSessionRef.endsWith('primary-nova')) {
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
                registrationId: 'reg_2',
                laneRef: 'main',
                runtimeId: 'rt_2',
                attemptId: 'att_2',
                invocationId: 'inv_2',
                attachEpoch: 1,
                requestId: 'req_2',
                operationId: 'op_2',
              },
            },
          }
        }
        return {
          status: 409,
          body: { status: 'rejected', reason: 'participant_scope_occupied', detail: 'held' },
        }
      }
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_2',
          attemptId: 'att_2',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      const outcome = await chooseScopeAndJoin({
        hrcSocketPath: sock,
        projectId: 'demo',
        hostIncarnationId: 'host-incarnation:test',
        socketPath: '/tmp/desktop-broker.sock',
        classId: 'codex-desktop',
        preparation: {
          schema: 'codex-desktop.participant-preparation/1',
          nativeThreadId: THREAD_ID,
          homeIdentity: '/tmp/home',
          sqliteHome: '/tmp/home',
          registrationKey: 'rk',
          rolloutPath: '/tmp/rollout',
          workspaceCwd: '/tmp/ws',
          projectRoot: '/tmp/ws',
          nativeAttemptStorePath: '/tmp/a.db',
        },
        participantKey: 'rk',
        workspaceCwd: '/tmp/ws',
        adapter: {
          adapterId: 'test/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => ({ status: 'prepared' as const, profile: { kind: 'p' } as never }),
        },
      })
      expect(seen).toEqual([
        'agent:stella:project:demo:task:primary-nova',
        'agent:stella:project:demo:task:primary-comet',
      ])
      expect(outcome.exit).toBe('joined')
    } finally {
      stop()
    }
  })

  test('redirect without advancing, pending as a hold', async () => {
    const seen: string[] = []
    const redirect = stubHrc((path, body) => {
      if (path === '/v1/participants/register') {
        seen.push((body as any).requestedSessionRef)
        return {
          status: 409,
          body: {
            status: 'rejected',
            reason: 'participant_scope_bound_elsewhere',
            detail: 'elsewhere',
            observed: { homeNodeId: 'node-b' },
          },
        }
      }
      throw new Error('must not attach')
    })
    try {
      const outcome = await chooseScopeAndJoin({
        hrcSocketPath: redirect.sock,
        projectId: 'demo',
        hostIncarnationId: 'host-incarnation:test',
        socketPath: '/tmp/desktop-broker.sock',
        classId: 'codex-desktop',
        preparation: { schema: 'x' },
        participantKey: 'rk',
        workspaceCwd: '/tmp/ws',
        adapter: {
          adapterId: 'test/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => ({ status: 'prepared' as const, profile: {} as never }),
        },
      })
      expect(outcome.exit).toBe('redirect')
      expect(seen).toEqual(['agent:stella:project:demo:task:primary-nova'])
    } finally {
      redirect.stop()
    }
    const holding = stubHrc(() => ({
      status: 200,
      body: { status: 'pending', reason: 'host_retirement_unproven', detail: 'hold' },
    }))
    try {
      let prepared = false
      const outcome = await chooseScopeAndJoin({
        hrcSocketPath: holding.sock,
        projectId: 'demo',
        hostIncarnationId: 'host-incarnation:test',
        socketPath: '/tmp/desktop-broker.sock',
        classId: 'codex-desktop',
        preparation: { schema: 'x' },
        participantKey: 'rk',
        workspaceCwd: '/tmp/ws',
        adapter: {
          adapterId: 'test/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => {
            prepared = true
            return { status: 'prepared' as const, profile: {} as never }
          },
        },
      })
      expect(outcome.exit).toBe('pending-hold')
      expect(prepared).toBe(false)
    } finally {
      holding.stop()
    }
  })

  test('jumps to the held address on incarnation_bound_elsewhere and replays', async () => {
    const seen: string[] = []
    const HELD = 'agent:stella:project:demo:task:primary-comet'
    const { sock, stop } = stubHrc((path, body) => {
      if (path === '/v1/participants/register') {
        seen.push((body as any).requestedSessionRef)
        if ((body as any).requestedSessionRef !== HELD) {
          return {
            status: 409,
            body: {
              status: 'rejected',
              reason: 'participant_host_incarnation_bound_elsewhere',
              detail: `host incarnation host-incarnation:test already holds ${HELD}; one incarnation holds at most one address`,
            },
          }
        }
        return {
          status: 200,
          body: {
            status: 'registered',
            scopeRef: HELD,
            hostSessionId: 'hs_1',
            generation: 1,
            created: false,
            resumed: false,
            observation: { state: 'attachment_pending', detail: 'replay' },
            identity: {
              registrationId: 'reg_h',
              laneRef: 'main',
              runtimeId: 'rt_h',
              attemptId: 'att_h',
              invocationId: 'inv_h',
              attachEpoch: 1,
              requestId: 'req_h',
              operationId: 'op_h',
            },
          },
        }
      }
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_h',
          attemptId: 'att_h',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      const outcome = await chooseScopeAndJoin({
        hrcSocketPath: sock,
        projectId: 'demo',
        hostIncarnationId: 'host-incarnation:test',
        socketPath: '/tmp/desktop-broker.sock',
        classId: 'codex-desktop',
        preparation: { schema: 'x' },
        participantKey: 'rk',
        workspaceCwd: '/tmp/ws',
        adapter: {
          adapterId: 'test/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => ({ status: 'prepared' as const, profile: { kind: 'p' } as never }),
        },
      })
      expect(seen).toEqual(['agent:stella:project:demo:task:primary-nova', HELD])
      expect(outcome.exit).toBe('joined')
    } finally {
      stop()
    }
  })
})

describe('desktop-join write-ahead resume', () => {
  test('resumeFromScope is tried before the slot sequence', async () => {
    const seen: string[] = []
    const HELD = 'agent:stella:project:demo:task:primary-comet'
    const candidates: string[] = []
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
              registrationId: 'reg_w',
              laneRef: 'main',
              runtimeId: 'rt_w',
              attemptId: 'att_w',
              invocationId: 'inv_w',
              attachEpoch: 1,
              requestId: 'req_w',
              operationId: 'op_w',
            },
          },
        }
      }
      return {
        status: 200,
        body: {
          status: 'attached',
          registrationId: 'reg_w',
          attemptId: 'att_w',
          attachEpoch: 1,
          prepared: true,
          observation: { state: 'attached', detail: 'ok' },
        },
      }
    })
    try {
      const { chooseScopeAndJoin: choose } = await import('../src/desktop-join.js')
      const outcome = await choose({
        hrcSocketPath: sock,
        projectId: 'demo',
        hostIncarnationId: 'host-incarnation:test',
        socketPath: '/tmp/desktop-broker.sock',
        classId: 'codex-desktop',
        preparation: { schema: 'x' },
        participantKey: 'rk',
        workspaceCwd: '/tmp/ws',
        resumeFromScope: HELD,
        onCandidateScope: (scope) => {
          candidates.push(scope)
        },
        adapter: {
          adapterId: 'test/1',
          admit: () => ({ status: 'rejected' as const, reason: 'unused' }),
          prepare: () => ({ status: 'prepared' as const, profile: { kind: 'p' } as never }),
        },
      })
      expect(seen).toEqual([HELD])
      expect(candidates).toEqual([HELD])
      expect(outcome.exit).toBe('joined')
    } finally {
      stop()
    }
  })

  test('runDesktopJoin resumes a registering write-ahead instead of restarting at nova', async () => {
    const { runDesktopJoin, threadPaths, admitDesktopThread } = await import(
      '../src/desktop-join.js'
    )
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
          serve: (async () => ({ broker: {}, socketPath: 'x', close: async () => {} })) as never,
          blockForever: (async () => {}) as never,
        }
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
