/**
 * T-14467: when a joined session ends, the joiner removes its state only once
 * HRC has acked the driver's `invocation.exited`, releases broker.pid and
 * exits. Without that ack the state stays for the joining hook's sweep.
 * Driven through runDesktopJoin against a stub HRC, with `serve` injected.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createCodexDesktopJoinClient } from '../src/desktop-join-codex.js'
import {
  type DesktopSessionHooks,
  type JoinLifecycle,
  runDesktopJoin,
} from '../src/desktop-join.js'
import {
  THREAD_ID,
  attached,
  cleanupDesktopJoinFixtures,
  desktopJoinFixture,
  fixtureIncarnation,
  joinLogEvents,
  registered,
  runJoin,
  stubHrc,
} from './desktop-join-fixture.js'

afterEach(cleanupDesktopJoinFixtures)

async function joinedSession(options: { exitAckTimeoutMs: number }) {
  const fixture = await desktopJoinFixture()
  const { sock, stop } = stubHrc((path, body) =>
    path === '/v1/participants/register' ? registered(body.requestedSessionRef) : attached
  )
  const input = {
    threadId: THREAD_ID,
    codexHome: fixture.codexHome,
    rolloutPath: fixture.rolloutPath,
    hrcSocketPath: sock,
    projectRoot: fixture.workspace,
    reportedBundleExecutable: fixture.bundle,
  }
  const client = createCodexDesktopJoinClient(input)
  let hooks: DesktopSessionHooks | undefined
  let onEventsAcked: ((ack: { invocationId: string; ackedThroughSeq: number }) => void) | undefined
  let brokerClosed = false
  let exited: (code: number) => void = () => {}
  // The CLI's lifecycle: its `exit` handler logs through it after teardown.
  const lifecycle: JoinLifecycle = { phase: 'starting' }
  const exitCode = new Promise<number>((resolve) => {
    exited = resolve
  })
  const outcome = runDesktopJoin(
    {
      ...client,
      createDriver: (session) => {
        hooks = session
        return {} as never
      },
    },
    input,
    {
      serve: (async (serveOptions: {
        desktopDriver: () => unknown
        onEventsAcked: typeof onEventsAcked
      }) => {
        serveOptions.desktopDriver()
        onEventsAcked = serveOptions.onEventsAcked
        return {
          broker: {},
          socketPath: 'x',
          close: async () => {
            brokerClosed = true
          },
        }
      }) as never,
      blockForever: (() => exitCode.then(() => undefined)) as never,
      onDeadline: () => {},
      lifecycle,
      exit: (code) => exited(code),
      exitAckTimeoutMs: options.exitAckTimeoutMs,
    }
  )
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (joinLogEvents(fixture, 'joined').length > 0) {
        clearInterval(poll)
        resolve()
      }
    }, 10)
  })
  stop()
  const endedLog = join(dirname(dirname(fixture.paths.stateDir)), 'hrc-desktop-ended.log')
  return {
    fixture,
    endedLog,
    end: () =>
      hooks?.sessionEnded({
        reason: 'pid_gone',
        detail: { sessionPid: 4242 },
        invocationId: 'inv_1',
        exitedSeq: 9,
      }),
    ack: (ackedThroughSeq: number) => onEventsAcked?.({ invocationId: 'inv_1', ackedThroughSeq }),
    exitCode,
    lifecycle,
    outcome,
    brokerClosed: () => brokerClosed,
  }
}

describe('desktop-join session end (T-14467)', () => {
  test('HRC acks the exit: broker closed, broker.pid released, state removed, one ended line', async () => {
    const session = await joinedSession({ exitAckTimeoutMs: 5_000 })
    const { paths } = session.fixture
    expect(existsSync(paths.pidFile)).toBe(true)
    expect(existsSync(paths.scopeCacheFile)).toBe(true)

    session.end()
    // An ack short of the exit is not the exit.
    session.ack(8)
    // Past the post-ack settle, so an early ack would already have removed it.
    await Bun.sleep(1_200)
    expect(existsSync(paths.stateDir)).toBe(true)
    expect(joinLogEvents(session.fixture, 'session-ended')[0]).toMatchObject({
      reason: 'pid_gone',
      sessionPid: 4242,
      pid: process.pid,
      invocationId: 'inv_1',
      exitedSeq: 9,
    })

    session.ack(9)
    expect(await session.exitCode).toBe(0)
    // As the CLI's process exit handler does: it must not recreate the dir.
    session.lifecycle.log?.('exit', { code: 0 })
    expect(session.brokerClosed()).toBe(true)
    expect(existsSync(paths.stateDir)).toBe(false)
    expect(existsSync(paths.scopeCacheFile)).toBe(false)
    const ended = readFileSync(session.endedLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(ended).toEqual([
      expect.objectContaining({
        sessionId: THREAD_ID,
        reason: 'pid_gone',
        invocationId: 'inv_1',
        exitedSeq: 9,
        recorded: true,
        stateRemoved: true,
      }),
    ])
    expect((await session.outcome).reason).toBe('serving')
    // The binding a resumed session needs survives, and nothing else.
    expect(JSON.parse(readFileSync(paths.endedFile, 'utf8'))).toEqual({
      phase: 'ended',
      scopeRef: 'agent:stella:project:workspace:task:primary-nova',
      registrationId: 'reg_1',
      hostIncarnationId: await fixtureIncarnation(session.fixture),
      runtimeId: 'rt_1',
      generation: 1,
      endedAt: expect.any(String),
    })
    expect(statSync(paths.endedFile).mode & 0o777).toBe(0o600)
    expect(ended[0].keptBinding).toBe(true)
  })

  test('a session resumed after a clean end rejoins from its ended record as the replacement', async () => {
    const session = await joinedSession({ exitAckTimeoutMs: 5_000 })
    const { paths } = session.fixture
    session.end()
    session.ack(9)
    await session.exitCode
    const ended = JSON.parse(readFileSync(paths.endedFile, 'utf8'))
    expect(existsSync(paths.joinFile)).toBe(false)

    // The app reopens the same session: its next hook starts a joiner.
    const resumed = await runJoin(session.fixture, (scopeRef) => registered(scopeRef))
    expect(resumed.outcome.reason).toBe('serving')
    const register = resumed.requests.find((r) => r.path === '/v1/participants/register')
    expect(register?.body.requestedSessionRef).toBe(ended.scopeRef)
    expect(register?.body.expectedPredecessor).toEqual({
      hostIncarnationId: ended.hostIncarnationId,
      runtimeId: 'rt_1',
      generation: 1,
    })
    expect(joinLogEvents(session.fixture, 'joined').at(-1)).toMatchObject({
      respawn: true,
      fromEndedRecord: true,
    })
    // Joined again: join.json is the record now, and the ended one is spent.
    expect(existsSync(paths.endedFile)).toBe(false)
    expect(JSON.parse(readFileSync(paths.joinFile, 'utf8')).phase).toBe('joined')
  })

  test('no ack within the window: broker.pid released and exit, but the state stays for the sweep', async () => {
    const session = await joinedSession({ exitAckTimeoutMs: 100 })
    const { paths } = session.fixture
    session.end()
    expect(await session.exitCode).toBe(0)
    expect(session.brokerClosed()).toBe(true)
    expect(existsSync(paths.pidFile)).toBe(false)
    expect(existsSync(paths.joinFile)).toBe(true)
    expect(joinLogEvents(session.fixture, 'exit-unacknowledged')).toHaveLength(1)
    expect(JSON.parse(readFileSync(session.endedLog, 'utf8'))).toMatchObject({
      recorded: false,
      stateRemoved: false,
      keptBinding: false,
    })
    // join.json itself stays, so nothing else is needed for a respawn.
    expect(existsSync(paths.endedFile)).toBe(false)
  })
})
