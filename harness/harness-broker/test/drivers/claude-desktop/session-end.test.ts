/**
 * T-14467: archiving a Claude Desktop session fires no SessionEnd hook, so the
 * broker watches the session's own process. A real broker drives the real
 * driver; the session is a real child process with a registry row whose
 * `procStart` is what `ps` reports for it, as Claude writes it.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Subprocess, spawn } from 'bun'
import type { ClaudeDesktopSessionEnd } from '../../../src/drivers/claude-desktop/driver'
import { systemSessionProbe } from '../../../src/drivers/claude-desktop/session-watch'
import { DESKTOP_SESSION_ID, humanPrompt } from './desktop-rows'
import {
  claudeHome,
  desktopBroker,
  desktopSpec,
  ofType,
  removeTempDirs,
  waitFor,
} from './observer-harness'

const children: Subprocess[] = []
afterEach(() => {
  while (children.length > 0) children.pop()?.kill('SIGKILL')
  removeTempDirs()
})

/** A live process standing in for the session's claude, with its registry row. */
async function liveSession(home: string): Promise<{
  pid: number
  child: Subprocess
  row: Record<string, unknown>
  writeRow: (row: Record<string, unknown>) => void
  removeRow: () => void
}> {
  const child = spawn(['sleep', '60'], { stdout: 'ignore', stderr: 'ignore' })
  children.push(child)
  const procStart = await systemSessionProbe.procStart(child.pid)
  if (procStart === undefined) throw new Error('ps reported no start time for the child')
  const sessions = join(home, 'sessions')
  mkdirSync(sessions, { recursive: true })
  const path = join(sessions, `${child.pid}.json`)
  const row = {
    pid: child.pid,
    sessionId: DESKTOP_SESSION_ID,
    cwd: '/Users/example/project',
    // As Claude writes it: `ps -o lstart=` in UTC, single-spaced.
    procStart,
    entrypoint: 'claude-desktop',
  }
  const writeRow = (next: Record<string, unknown>) => writeFileSync(path, JSON.stringify(next))
  writeRow(row)
  return { pid: child.pid, child, row, writeRow, removeRow: () => rmSync(path) }
}

async function watchedBroker(pid: number, home: string, invocationId: string) {
  const ended: ClaudeDesktopSessionEnd[] = []
  const { broker, events } = desktopBroker({
    claudeHome: home,
    driver: { sessionWatch: { pid, intervalMs: 20, onEnded: (end) => ended.push(end) } },
  })
  await broker.start({ spec: desktopSpec(invocationId) })
  return { broker, events, ended }
}

/** Long enough for the watcher to have run several checks. */
const severalChecks = () => Bun.sleep(150)

describe('claude-desktop session end (T-14467)', () => {
  test('pid death: the invocation exits once, after the last transcript rows are published', async () => {
    const fake = claudeHome()
    fake.write(humanPrompt('p1', 'hello'))
    const session = await liveSession(fake.home)
    const { events, ended } = await watchedBroker(session.pid, fake.home, 'inv-pid-death')
    await waitFor(() => ofType(events, 'user.message').length === 1)
    await severalChecks()
    expect(ofType(events, 'invocation.exited')).toHaveLength(0)

    session.child.kill('SIGKILL')
    await session.child.exited
    await waitFor(() => ended.length === 1)
    await severalChecks()

    const exited = ofType(events, 'invocation.exited')
    expect(exited).toHaveLength(1)
    expect(exited[0]?.payload).toEqual({ exitCode: null, signal: null })
    const notice = ofType(events, 'driver.notice').find(
      (event) => (event.payload as { code?: string }).code === 'CLAUDE_DESKTOP_SESSION_ENDED'
    )
    expect((notice?.payload as { data: unknown }).data).toEqual({
      reason: 'pid_gone',
      sessionPid: session.pid,
    })
    expect(ended).toEqual([
      {
        reason: 'pid_gone',
        detail: { sessionPid: session.pid },
        invocationId: 'inv-pid-death',
        exitedSeq: exited[0]?.seq as number,
      },
    ])
    // The exit is the stream's last word on the session.
    expect(events.at(-1)?.type).toBe('invocation.exited')
  })

  test('pid reuse: a live pid that started at another time than the row says is not the session', async () => {
    const fake = claudeHome()
    const session = await liveSession(fake.home)
    // The row a crashed claude left behind, now pointing at a later process.
    session.writeRow({ ...session.row, procStart: 'Thu Jan 1 00:00:00 1970' })
    const { events, ended } = await watchedBroker(session.pid, fake.home, 'inv-pid-reuse')
    await waitFor(() => ended.length === 1)

    expect(ended[0]?.reason).toBe('proc_start_mismatch')
    expect(ended[0]?.detail).toEqual({
      sessionPid: session.pid,
      rowProcStart: 'Thu Jan 1 00:00:00 1970',
      processStart: session.row['procStart'],
    })
    expect(ofType(events, 'invocation.exited')).toHaveLength(1)
  })

  test('registry row gone: the pid is alive but its row was removed', async () => {
    const fake = claudeHome()
    const session = await liveSession(fake.home)
    const { events, ended } = await watchedBroker(session.pid, fake.home, 'inv-row-gone')
    await severalChecks()
    expect(ended).toHaveLength(0)

    session.removeRow()
    await waitFor(() => ended.length === 1)
    expect(ended[0]?.reason).toBe('registry_row_gone')
    expect(ended[0]?.detail).toEqual({ sessionPid: session.pid })
    expect(ofType(events, 'invocation.exited')).toHaveLength(1)
  })

  test('registry row gone: the pid row now names another session', async () => {
    const fake = claudeHome()
    const session = await liveSession(fake.home)
    const { ended } = await watchedBroker(session.pid, fake.home, 'inv-row-replaced')
    await severalChecks()
    session.writeRow({ ...session.row, sessionId: 'another-session' })
    await waitFor(() => ended.length === 1)
    expect(ended[0]?.reason).toBe('registry_row_gone')
    expect(ended[0]?.detail).toEqual({ sessionPid: session.pid, rowSessionId: 'another-session' })
  })

  test('a row caught mid-write is no verdict: the session lives on', async () => {
    const fake = claudeHome()
    const session = await liveSession(fake.home)
    const { events, ended } = await watchedBroker(session.pid, fake.home, 'inv-mid-write')
    writeFileSync(join(fake.home, 'sessions', `${session.pid}.json`), '{"pid":')
    await severalChecks()
    expect(ended).toHaveLength(0)
    expect(ofType(events, 'invocation.exited')).toHaveLength(0)

    // And once the row is whole again, a real death is still seen.
    session.writeRow(session.row)
    session.child.kill('SIGKILL')
    await waitFor(() => ended.length === 1)
    expect(ended[0]?.reason).toBe('pid_gone')
  })

  test('a stopped broker stops watching: no exit is reported for a stop', async () => {
    const fake = claudeHome()
    const session = await liveSession(fake.home)
    const { broker, events, ended } = await watchedBroker(session.pid, fake.home, 'inv-stopped')
    await broker.stop({ invocationId: 'inv-stopped' as never, reason: 'test' })
    const exitsAfterStop = ofType(events, 'invocation.exited').length
    session.child.kill('SIGKILL')
    await severalChecks()
    expect(ended).toHaveLength(0)
    expect(ofType(events, 'invocation.exited')).toHaveLength(exitsAfterStop)
  })
})
