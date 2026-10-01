/**
 * desktop-join liveness (T-09977). Incident 2026-10-01: the first joiner for a
 * new Desktop thread took broker.pid, then died on an uncaught `wrkq projects`
 * rejection with its stderr sent to /dev/null. It left no join.log line, and the
 * thread stayed on its provisional codex-<id> address for 2m20s.
 *
 * Each case runs the REAL `harness-broker desktop-join` CLI as a detached-style
 * subprocess against a fake `wrkq` on PATH and a stub HRC unix socket. Join.log
 * is the only observation, as it is in production.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const BIN = resolve(import.meta.dir, '..', 'bin', 'harness-broker.js')
const THREAD_ID = '0aaa0001-0000-7000-8000-00000000abcd'

type Fixture = {
  root: string
  codexHome: string
  workspace: string
  rolloutPath: string
  bundleExecutable: string
  fakeBin: string
  threadDir: string
  joinLog: string
  pidFile: string
}

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    try {
      cleanup()
    } catch {}
  }
})

async function fixture(wrkq: 'ok' | 'fail' | 'hang'): Promise<Fixture> {
  // Short root: the per-thread broker socket must fit sockaddr_un.
  const root = await mkdtemp('/tmp/dj-')
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  const codexHome = join(root, 'codex')
  const workspace = join(root, 'ws')
  mkdirSync(workspace, { recursive: true })
  const rolloutDir = join(codexHome, 'sessions')
  mkdirSync(rolloutDir, { recursive: true })
  const rolloutPath = join(rolloutDir, `rollout-${THREAD_ID}.jsonl`)
  writeFileSync(
    rolloutPath,
    `${JSON.stringify({
      type: 'session_meta',
      payload: {
        session_id: THREAD_ID,
        source: 'vscode',
        thread_source: 'user',
        originator: 'Codex Desktop',
        cwd: workspace,
      },
    })}\n`
  )
  const bundleExecutable = join(root, 'codex-bundle')
  writeFileSync(bundleExecutable, '#!/bin/sh\n')
  chmodSync(bundleExecutable, 0o755)
  const fakeBin = join(root, 'bin')
  mkdirSync(fakeBin)
  const projects = JSON.stringify([
    { type: 'project', slug: 'demo', path: 'demo', root: workspace },
  ])
  const body =
    wrkq === 'ok'
      ? `printf '%s' '${projects}'\n`
      : wrkq === 'fail'
        ? `echo 'Error: the wrkq ledger transport lost its session' >&2\nexit 1\n`
        : 'exec sleep 60\n'
  writeFileSync(join(fakeBin, 'wrkq'), `#!/bin/sh\n${body}`)
  chmodSync(join(fakeBin, 'wrkq'), 0o755)
  const threadDir = join(codexHome, 'hrc-desktop', THREAD_ID)
  return {
    root,
    codexHome,
    workspace,
    rolloutPath,
    bundleExecutable,
    fakeBin,
    threadDir,
    joinLog: join(threadDir, 'join.log'),
    pidFile: join(threadDir, 'broker.pid'),
  }
}

type HrcMode = 'join' | 'hang'

function stubHrc(mode: HrcMode): { sock: string; registers: () => number } {
  const sock = join('/tmp', `dj-hrc-${process.pid}-${Math.random().toString(36).slice(2)}.sock`)
  let registers = 0
  const server = Bun.serve({
    unix: sock,
    async fetch(request) {
      const url = new URL(request.url)
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
      if (url.pathname === '/v1/participants/register') {
        registers += 1
        if (mode === 'hang') return new Promise<Response>(() => {})
        return Response.json({
          status: 'registered',
          scopeRef: body['requestedSessionRef'],
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
        })
      }
      return Response.json({
        status: 'attached',
        registrationId: 'reg_1',
        attemptId: 'att_1',
        attachEpoch: 1,
        prepared: true,
        observation: { state: 'attached', detail: 'ok' },
      })
    },
  })
  cleanups.push(() => server.stop(true))
  return { sock, registers: () => registers }
}

function startJoiner(
  fx: Fixture,
  hrcSock: string,
  extra: string[] = []
): { child: ChildProcess; exited: Promise<number | null> } {
  const child = spawn(
    'bun',
    [
      BIN,
      'desktop-join',
      '--thread',
      THREAD_ID,
      '--rollout',
      fx.rolloutPath,
      '--cwd',
      fx.workspace,
      '--codex-home',
      fx.codexHome,
      '--hrc-socket',
      hrcSock,
      '--bundle-executable',
      fx.bundleExecutable,
      '--source',
      'startup',
      ...extra,
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PATH: `${fx.fakeBin}:${process.env['PATH'] ?? ''}`, HOME: fx.root },
    }
  )
  cleanups.push(() => child.kill('SIGKILL'))
  const exited = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
  return { child, exited }
}

function joinEvents(fx: Fixture): Array<Record<string, unknown>> {
  if (!existsSync(fx.joinLog)) return []
  return readFileSync(fx.joinLog, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    if (predicate()) return true
    await Bun.sleep(50)
  }
  return predicate()
}

function pidFileOwner(fx: Fixture): number | undefined {
  try {
    return Number(readFileSync(fx.pidFile, 'utf8').trim())
  } catch {
    return undefined
  }
}

describe('desktop-join never dies silently and never holds the door', () => {
  test('a failing wrkq registry is a typed retryable line, then a deadline that releases broker.pid', async () => {
    const fx = await fixture('fail')
    const hrc = stubHrc('join')
    const { child, exited } = startJoiner(fx, hrc.sock, ['--deadline-ms', '2500'])
    expect(await exited).toBe(0)
    const events = joinEvents(fx)
    const names = events.map((event) => event['event'])
    expect(names).toContain('registry-unavailable')
    expect(names).toContain('join-deadline')
    expect(names.at(-1)).toBe('exit')
    const unavailable = events.find((event) => event['event'] === 'registry-unavailable')
    expect(unavailable?.['retryable']).toBe(true)
    expect(String(unavailable?.['message'])).toContain('wrkq')
    // Every line names its writer; the holder's own pid is never overwritten.
    for (const event of events) expect(event['pid']).toBe(child.pid)
    expect(pidFileOwner(fx)).not.toBe(child.pid)
    expect(hrc.registers()).toBe(0)
  }, 20_000)

  test('a hanging wrkq times out per attempt instead of holding the joiner', async () => {
    const fx = await fixture('hang')
    const hrc = stubHrc('join')
    const started = Date.now()
    const { exited } = startJoiner(fx, hrc.sock, ['--deadline-ms', '3000'])
    expect(await exited).toBe(0)
    expect(Date.now() - started).toBeLessThan(9_000)
    const names = joinEvents(fx).map((event) => event['event'])
    expect(names).toContain('registry-unavailable')
    expect(names).toContain('join-deadline')
  }, 20_000)

  test('with wrkq down, the last-good registry still joins and says so', async () => {
    const ok = await fixture('ok')
    const hrcOk = stubHrc('join')
    const first = startJoiner(ok, hrcOk.sock)
    expect(await waitFor(() => joinEvents(ok).some((e) => e['event'] === 'joined'), 15_000)).toBe(
      true
    )
    first.child.kill('SIGTERM')
    await first.exited
    expect(existsSync(join(ok.codexHome, 'hrc-desktop-registry.json'))).toBe(true)

    // Same codex home, a new thread directory, wrkq now failing.
    const fail = await fixture('fail')
    mkdirSync(fail.codexHome, { recursive: true })
    writeFileSync(
      join(fail.codexHome, 'hrc-desktop-registry.json'),
      readFileSync(join(ok.codexHome, 'hrc-desktop-registry.json'))
    )
    // Point the cached root at this fixture's workspace.
    const cache = JSON.parse(
      readFileSync(join(fail.codexHome, 'hrc-desktop-registry.json'), 'utf8')
    )
    cache.projects = [{ projectId: 'demo', root: fail.workspace }]
    writeFileSync(join(fail.codexHome, 'hrc-desktop-registry.json'), JSON.stringify(cache))
    const hrc = stubHrc('join')
    const second = startJoiner(fail, hrc.sock)
    expect(await waitFor(() => joinEvents(fail).some((e) => e['event'] === 'joined'), 15_000)).toBe(
      true
    )
    const names = joinEvents(fail).map((event) => event['event'])
    expect(names).toContain('registry-last-good')
    second.child.kill('SIGTERM')
    await second.exited
  }, 40_000)

  test('a hanging HRC register is bounded: typed transport line, deadline, broker.pid released', async () => {
    const fx = await fixture('ok')
    const hrc = stubHrc('hang')
    const { child, exited } = startJoiner(fx, hrc.sock, ['--deadline-ms', '3000'])
    expect(await exited).toBe(0)
    const names = joinEvents(fx).map((event) => event['event'])
    expect(names).toContain('join-deadline')
    expect(names.at(-1)).toBe('exit')
    expect(pidFileOwner(fx)).not.toBe(child.pid)
    expect(hrc.registers()).toBeGreaterThanOrEqual(1)
  }, 20_000)

  test('SIGTERM before join is a typed signal line and releases broker.pid', async () => {
    const fx = await fixture('hang')
    const hrc = stubHrc('join')
    const { child, exited } = startJoiner(fx, hrc.sock, ['--deadline-ms', '30000'])
    expect(await waitFor(() => pidFileOwner(fx) === child.pid, 10_000)).toBe(true)
    child.kill('SIGTERM')
    await exited
    const events = joinEvents(fx)
    const signal = events.find((event) => event['event'] === 'signal')
    expect(signal?.['signal']).toBe('SIGTERM')
    expect(typeof signal?.['phase']).toBe('string')
    expect(events.at(-1)?.['event']).toBe('exit')
    expect(pidFileOwner(fx)).not.toBe(child.pid)
  }, 20_000)

  test('a live holder past the deadline that never joined is replaced, not obeyed', async () => {
    const fx = await fixture('ok')
    const hrc = stubHrc('join')
    // An unrelated live process squats on broker.pid (pid reuse, or a wedged
    // joiner): it is not serving and its claim is older than deadline+grace.
    const squatter = spawn('sleep', ['60'], { stdio: 'ignore' })
    cleanups.push(() => squatter.kill('SIGKILL'))
    mkdirSync(fx.threadDir, { recursive: true })
    writeFileSync(fx.pidFile, `${squatter.pid}\n`)
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(fx.pidFile, old, old)
    const joiner = startJoiner(fx, hrc.sock, ['--deadline-ms', '3000'])
    expect(await waitFor(() => joinEvents(fx).some((e) => e['event'] === 'joined'), 15_000)).toBe(
      true
    )
    const stalled = joinEvents(fx).find((event) => event['event'] === 'stalled-holder')
    expect(stalled?.['holderPid']).toBe(squatter.pid)
    // Not our process: never signalled.
    expect(squatter.exitCode).toBeNull()
    expect(squatter.signalCode).toBeNull()
    joiner.child.kill('SIGTERM')
    await joiner.exited
  }, 30_000)

  test('a young live holder that has not joined yet is join-in-progress, and a joined one is already-serving', async () => {
    const fx = await fixture('ok')
    const hrc = stubHrc('join')
    const first = startJoiner(fx, hrc.sock)
    expect(await waitFor(() => joinEvents(fx).some((e) => e['event'] === 'joined'), 15_000)).toBe(
      true
    )
    // Make the claim ancient: a JOINED holder is serving regardless of age.
    const old = new Date(Date.now() - 60 * 60_000)
    utimesSync(fx.pidFile, old, old)
    const second = startJoiner(fx, hrc.sock, ['--deadline-ms', '3000'])
    expect(await second.exited).toBe(0)
    const serving = joinEvents(fx).filter((event) => event['event'] === 'already-serving')
    expect(serving.at(-1)?.['holderPid']).toBe(first.child.pid)
    expect(serving.at(-1)?.['pid']).toBe(second.child.pid)
    first.child.kill('SIGTERM')
    await first.exited

    const young = await fixture('ok')
    const squatter = spawn('sleep', ['60'], { stdio: 'ignore' })
    cleanups.push(() => squatter.kill('SIGKILL'))
    mkdirSync(young.threadDir, { recursive: true })
    writeFileSync(young.pidFile, `${squatter.pid}\n`)
    const third = startJoiner(young, hrc.sock, ['--deadline-ms', '3000'])
    expect(await third.exited).toBe(0)
    const inProgress = joinEvents(young).find((event) => event['event'] === 'join-in-progress')
    expect(inProgress?.['holderPid']).toBe(squatter.pid)
  }, 40_000)
})
