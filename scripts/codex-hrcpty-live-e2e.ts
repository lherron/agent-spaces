#!/usr/bin/env bun

/**
 * T-12166: a codex-hrcpty seat end to end, against a real `hrc-pty serve`,
 * the real broker and the real Codex binary (T-12162 §4.2, gate G2 and the
 * G5 lifecycle legs). The attaching terminals are `hrc-pty attach` clients
 * running in a scratch tmux server, which answers the TUI's startup queries.
 *
 * Seat 1 (one short model turn):
 *   birth        the broker spawns the app-server in its own process group
 *                and the seat reports ready; hrc-pty has no child
 *   turn         the launch input completes through thread/queue/add
 *   read-only    a read-only attach spawns nothing
 *   read-write   the first read-write attach spawns exactly one TUI, which
 *                shows the turn through `resume`
 *   detach       the TUI keeps running; a reattach spawns nothing new
 *   quit         Ctrl-C twice, 0.1 s apart (one quits; the second is a
 *                SIGINT the wrapper ignores) ends the invocation with
 *                continuation.cleared; no app-server remains
 *
 * Seats 2 and 3 (no model turn):
 *   lost server  SIGKILL (seat 2) or SIGTERM (seat 3) the app-server under a
 *                running TUI with the broker
 *                alive: the TUI exits, the invocation ends, and there is no
 *                continuation.cleared (Codex 0.163's TUI exits 0 on a lost
 *                server, so exit 0 alone is not a quit)
 *
 * Wrapper decision (stub TUI, no model): exit 0 with the app-server gone
 * posts `exited`; exit 0 or death by SIGINT with it up posts `quit`.
 *
 * Seat 4 (no model turn): a broker stop with the TUI attached signals the
 * TUI through hrc-pty and ends the app-server.
 *
 * A missing dependency is a failure, not a skip.
 *
 *   bun scripts/codex-hrcpty-live-e2e.ts --out <dir>
 */
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'

import { createBroker } from '../harness/harness-broker/src/broker'
import { resolveCodexTuiWrapperEntryPath } from '../harness/harness-broker/src/drivers/codex-app-server/codex-tui-wrapper'
import { HrcptyPtyController } from '../harness/harness-broker/src/runtime/hrcpty'
import { resolveHrcptyBinary } from '../harness/harness-broker/src/testing/hrcpty-supervisor'
import {
  type PlanContext,
  ROW_RECIPES,
  type RowPlan,
  resolveTmuxBin,
} from './lib/admission-matrix/rows'

type Check = { name: string; ok: boolean; detail: string }

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const TUI_SPAWNED = 'Codex TUI spawned for a read-write attach'

function parseArgs(argv: string[]): { out: string } {
  const index = argv.indexOf('--out')
  const out = index >= 0 ? argv[index + 1] : undefined
  if (out === undefined) throw new Error('usage: codex-hrcpty-live-e2e.ts --out <dir>')
  return { out }
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await Bun.sleep(200)
  }
  return await predicate()
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function psLine(pid: number): string {
  return spawnSync('ps', ['-o', 'pid=,pgid=,command=', '-p', String(pid)], {
    encoding: 'utf8',
  }).stdout.trim()
}

/** Every live process whose command line names this socket path. */
function processesOn(socketPath: string): string[] {
  const listed = spawnSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' }).stdout
  return listed
    .split('\n')
    .filter((line) => line.includes(socketPath) && !line.includes('ps -ax'))
    .map((line) => line.trim())
}

/**
 * The attach-only wrapper's quit decision, with a stub TUI standing in for
 * Codex so the exit is exactly what the case names: the envelope type it
 * posts to the control socket.
 */
async function wrapperDecision(tuiExit: 'exit 0' | 'SIGINT', serverLive: boolean) {
  const dir = mkdtempSync(join('/tmp', 'chw-'))
  const controlPath = join(dir, 'control.sock')
  const appPath = join(dir, 'app.sock')
  const tokenPath = join(dir, 'attach')
  const stub = join(dir, 'tui.sh')
  writeFileSync(tokenPath, 'thread-stub\n')
  writeFileSync(stub, `#!/bin/sh\n${tuiExit === 'SIGINT' ? 'kill -INT $$' : 'exit 0'}\n`)
  chmodSync(stub, 0o755)
  const envelopes: Array<{ type?: string }> = []
  const control = createServer((socket) => {
    let text = ''
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
    })
    socket.on('end', () => envelopes.push(JSON.parse(text)))
  })
  await new Promise<void>((resolve) => control.listen(controlPath, resolve))
  const app = serverLive ? createServer((socket) => socket.destroy()) : undefined
  if (app !== undefined) await new Promise<void>((resolve) => app.listen(appPath, resolve))
  const wrapper = Bun.spawn(
    [
      process.execPath,
      resolveCodexTuiWrapperEntryPath(),
      '--attach-only',
      '--command',
      stub,
      '--socket',
      appPath,
      '--attach-token',
      tokenPath,
      '--control-socket',
      controlPath,
      '--invocation-id',
      'inv_wrapper_stub',
    ],
    { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }
  )
  const exitCode = await wrapper.exited
  await Bun.sleep(200)
  control.close()
  app?.close()
  rmSync(dir, { recursive: true, force: true })
  return { exitCode, posted: envelopes.map((envelope) => envelope.type) }
}

async function main(): Promise<void> {
  const { out } = parseArgs(process.argv.slice(2))
  mkdirSync(out, { recursive: true })
  const logLines: string[] = []
  const log = (line: string): void => {
    const stamped = `${new Date().toISOString()} ${line}`
    logLines.push(stamped)
    process.stdout.write(`${stamped}\n`)
  }
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail })
    log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}`)
  }

  const found = ROW_RECIPES['codex-hrcpty']
  if (found === undefined) throw new Error('no codex-hrcpty recipe')
  const recipe = found
  const probe = recipe.probe()
  log(`probe ${probe.available ? 'OK' : 'MISSING'}: ${probe.reason}`)
  const hrcptyBinary = resolveHrcptyBinary()
  log(`hrc-pty ${hrcptyBinary}`)
  if (!probe.available || hrcptyBinary === undefined) {
    check('dependencies', false, probe.reason)
    finish()
    return
  }

  const tmuxBin = resolveTmuxBin()
  const work = mkdtempSync(join('/tmp', 'chl-'))
  const tmuxSocket = join(work, 'tmux.sock')
  const tmux = (...args: string[]) =>
    spawnSync(tmuxBin, ['-S', tmuxSocket, '-f', '/dev/null', ...args], { encoding: 'utf8' })
  const ctx: PlanContext = {
    repoRoot,
    tmuxBin,
    marker: `T12166_${Date.now().toString(36).toUpperCase()}`,
    hookIpcDir: join(work, 'ipc'),
    timeoutMs: 180_000,
  }
  mkdirSync(ctx.hookIpcDir, { recursive: true })
  tmux('new-session', '-d', '-s', 'outer', '-x', '120', '-y', '40')
  tmux('set-option', '-g', 'remain-on-exit', 'off')

  const capturePane = (window: string, file: string): string => {
    const text = tmux('capture-pane', '-p', '-t', `outer:${window}`).stdout
    writeFileSync(join(out, file), text)
    return text
  }

  async function runSeat(
    name: string,
    withTurn: boolean,
    body: (seat: {
      plan: RowPlan
      events: InvocationEventEnvelope[]
      invocationId: InvocationId
      socketPath: string
      pty: HrcptyPtyController
      appServerPid: number
      /** The app-server's `--listen` socket, read from its command line. */
      appServerSocket: string
      attach: (window: string, readOnly: boolean) => void
      tuiSpawns: () => number
      stop: () => Promise<void>
    }) => Promise<void>
  ): Promise<void> {
    log(`--- seat ${name} ---`)
    const plan = await recipe.plan({ ...ctx, marker: `${ctx.marker}_${name}` })
    const surface = plan.runtime?.terminalSurface
    if (surface?.kind !== 'hrcpty') throw new Error('plan carries no hrcpty lease')
    const socketPath = surface.socketPath
    const events: InvocationEventEnvelope[] = []
    const broker = createBroker({ drivers: [plan.driver], onEvent: (event) => events.push(event) })
    const startRequest = withTurn
      ? plan.startRequest
      : { ...plan.startRequest, initialInput: undefined }
    const invocationId = plan.startRequest.spec.invocationId as InvocationId
    const pty = new HrcptyPtyController({ socketPath, allowedOps: surface.allowedOps })
    try {
      await broker.start(startRequest, plan.dispatchEnv, plan.runtime)
      const ready = await waitFor(
        () => events.some((event) => event.type === 'invocation.ready'),
        60_000
      )
      check(`${name} birth ready`, ready, `invocation ${invocationId}`)
      const started = events.find((event) => event.type === 'invocation.started')
      const appServerPid = (started?.payload as { pid?: number } | undefined)?.pid ?? -1
      const line = psLine(appServerPid)
      const appServerSocket = /unix:\/\/(\S+)/.exec(line)?.[1] ?? '(none)'
      const ownPgid = psLine(process.pid).split(/\s+/)[1]
      check(
        `${name} app-server in broker group`,
        line.includes('app-server --listen unix://') && line.split(/\s+/)[1] === ownPgid,
        `${line} (broker pgid ${ownPgid})`
      )
      const attach = (window: string, readOnly: boolean): void => {
        tmux(
          'new-window',
          '-d',
          '-t',
          'outer',
          '-n',
          window,
          `${hrcptyBinary} attach --socket ${socketPath}${readOnly ? ' --read-only' : ''}`
        )
      }
      const tuiSpawns = () =>
        events.filter(
          (event) =>
            event.type === 'diagnostic' &&
            (event.payload as { message?: string }).message === TUI_SPAWNED
        ).length
      await body({
        plan,
        events,
        invocationId,
        socketPath,
        pty,
        appServerPid,
        appServerSocket,
        attach,
        tuiSpawns,
        stop: async () => {
          await broker.stop({ invocationId, graceMs: 1000 } as never).catch(() => undefined)
        },
      })
    } catch (error) {
      check(
        `${name} run`,
        false,
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      )
    } finally {
      pty.close()
      await broker.stop({ invocationId, graceMs: 1000 } as never).catch(() => undefined)
      await broker.dispose({ invocationId } as never).catch(() => undefined)
      writeFileSync(
        join(out, `${name}.events.ndjson`),
        `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
      )
      const supervisorLog = join(dirname(socketPath), 'hrcpty.log')
      if (existsSync(supervisorLog)) copyFileSync(supervisorLog, join(out, `${name}.hrcpty.log`))
      await plan.cleanup()
    }
  }

  const lostServerSeat = (name: string, signal: 'SIGKILL' | 'SIGTERM') =>
    runSeat(name, false, async (seat) => {
      const { events, pty } = seat
      seat.attach(`${name}rw`, false)
      const spawned = await waitFor(async () => {
        const status = (await pty.status()) as { child?: { state?: string } }
        return status.child?.state === 'running'
      }, 15_000)
      // The TUI is attached once its composer is up.
      await waitFor(
        () => /›|context left|gpt-/.test(capturePane(`${name}rw`, `${name}.before-kill.pane.txt`)),
        30_000
      )
      await Bun.sleep(1_000)
      check(`${name} TUI running`, spawned && seat.tuiSpawns() === 1, `spawns ${seat.tuiSpawns()}`)
      const listen = psLine(seat.appServerPid)
      process.kill(seat.appServerPid, signal)
      log(`${signal} app-server ${listen}`)
      const tuiGone = await waitFor(async () => {
        const status = (await pty.status()) as { child?: { state?: string } }
        return status.child?.state === 'exited'
      }, 20_000)
      const ended = await waitFor(
        () => events.some((event) => event.type === 'invocation.exited'),
        20_000
      )
      await Bun.sleep(2_000)
      capturePane(`${name}rw`, `${name}.after-kill.pane.txt`)
      const status = (await pty.status()) as { child?: unknown; broker?: unknown }
      const cleared = events.filter((event) => event.type === 'continuation.cleared')
      const remaining = processesOn(seat.appServerSocket)
      check(
        `${name} no app-server and no TUI remain`,
        !alive(seat.appServerPid) && remaining.length === 0,
        `processes on ${seat.appServerSocket}: ${JSON.stringify(remaining)}`
      )
      check(
        `${name} lost app-server (${signal}) keeps the continuation`,
        tuiGone && ended && cleared.length === 0,
        `tui ${JSON.stringify(status.child)}, invocation.exited ${ended}, continuation.cleared ${cleared.length}`
      )
      const diagnostics = events
        .filter((event) => event.type === 'diagnostic')
        .map((event) => (event.payload as { message?: string }).message)
        .filter((message) => message !== undefined && !message.startsWith('{'))
      log(`${name} diagnostics: ${JSON.stringify(diagnostics.slice(-6))}`)
    })

  try {
    for (const [tuiExit, serverLive, expected] of [
      ['exit 0', false, 'app-server-renderer.exited'],
      ['exit 0', true, 'app-server-renderer.quit'],
      ['SIGINT', true, 'app-server-renderer.quit'],
    ] as const) {
      const decision = await wrapperDecision(tuiExit, serverLive)
      check(
        `wrapper: TUI ${tuiExit} with server ${serverLive ? 'up' : 'gone'} posts ${expected.split('.')[1]}`,
        JSON.stringify(decision.posted) === JSON.stringify([expected]),
        JSON.stringify(decision)
      )
    }

    await runSeat('seat1', true, async (seat) => {
      const { events, pty } = seat
      const turnDone = await waitFor(
        () => events.some((event) => event.type === 'turn.completed'),
        120_000
      )
      const completed = events.find((event) => event.type === 'turn.completed')
      check('seat1 turn via queue', turnDone, `turn.completed ${completed?.turnId ?? 'none'}`)
      const answer = events
        .filter((event) => event.type === 'assistant.message.completed')
        .map((event) => JSON.stringify(event.payload))
        .join(' ')
      log(`assistant: ${answer.slice(0, 300)}`)

      const birth = (await pty.status()) as { child?: { state?: string } }
      check(
        'seat1 no TUI at birth',
        birth.child?.state === 'none' && seat.tuiSpawns() === 0,
        `child ${JSON.stringify(birth.child)}, spawns ${seat.tuiSpawns()}`
      )

      seat.attach('ro', true)
      await waitFor(async () => {
        const status = (await pty.status()) as { clients?: { readOnly?: number } }
        return status.clients?.readOnly === 1
      }, 10_000)
      await Bun.sleep(2_000)
      const roStatus = (await pty.status()) as {
        child?: { state?: string }
        clients?: Record<string, number>
      }
      check(
        'seat1 read-only attach spawns nothing',
        roStatus.clients?.['readOnly'] === 1 &&
          roStatus.child?.state === 'none' &&
          seat.tuiSpawns() === 0,
        `clients ${JSON.stringify(roStatus.clients)}, child ${JSON.stringify(roStatus.child)}`
      )
      tmux('kill-window', '-t', 'outer:ro')

      seat.attach('rw1', false)
      const spawned = await waitFor(async () => {
        const status = (await pty.status()) as { child?: { state?: string } }
        return status.child?.state === 'running'
      }, 15_000)
      const showsTurn = await waitFor(
        () => capturePane('rw1', 'seat1.rw1.pane.txt').includes('READY'),
        60_000
      )
      const rwStatus = (await pty.status()) as { child?: unknown; size?: unknown }
      check(
        'seat1 read-write attach spawns one TUI',
        spawned && seat.tuiSpawns() === 1,
        `spawns ${seat.tuiSpawns()}, child ${JSON.stringify(rwStatus.child)}, size ${JSON.stringify(rwStatus.size)}`
      )
      check(
        'seat1 TUI shows the turn via resume',
        showsTurn,
        'pane capture contains READY (seat1.rw1.pane.txt)'
      )

      tmux('kill-window', '-t', 'outer:rw1')
      await waitFor(async () => {
        const status = (await pty.status()) as { clients?: { total?: number } }
        return status.clients?.total === 0
      }, 10_000)
      await Bun.sleep(1_000)
      const detached = (await pty.status()) as { child?: { state?: string; pid?: number } }
      check(
        'seat1 detach leaves the TUI running',
        detached.child?.state === 'running',
        `child ${JSON.stringify(detached.child)}`
      )

      seat.attach('rw2', false)
      await waitFor(() => capturePane('rw2', 'seat1.rw2.pane.txt').includes('READY'), 20_000)
      await Bun.sleep(1_000)
      const reattached = (await pty.status()) as { child?: { state?: string; pid?: number } }
      check(
        'seat1 reattach spawns nothing new',
        seat.tuiSpawns() === 1 && reattached.child?.pid === detached.child?.pid,
        `spawns ${seat.tuiSpawns()}, child ${JSON.stringify(reattached.child)}`
      )

      // One Ctrl-C quits an empty composer; the second, 0.1 s behind it, lands
      // after the TUI restored cooked mode and is a SIGINT to the wrapper.
      tmux('send-keys', '-t', 'outer:rw2', 'C-c')
      await Bun.sleep(100)
      tmux('send-keys', '-t', 'outer:rw2', 'C-c')
      const ended = await waitFor(
        () => events.some((event) => event.type === 'invocation.exited'),
        20_000
      )
      await Bun.sleep(1_500)
      const cleared = events.filter((event) => event.type === 'continuation.cleared')
      const remaining = processesOn(seat.appServerSocket)
      check(
        'seat1 Ctrl-C quit ends the invocation with continuation.cleared',
        ended && cleared.length === 1,
        `invocation.exited ${ended}, continuation.cleared ${JSON.stringify(cleared.map((e) => e.payload))}`
      )
      check(
        'seat1 no app-server remains',
        !alive(seat.appServerPid) && remaining.length === 0,
        `app-server pid ${seat.appServerPid} alive=${alive(seat.appServerPid)}; processes on ${seat.appServerSocket}: ${JSON.stringify(remaining)}`
      )
    })

    await lostServerSeat('seat2', 'SIGKILL')
    await lostServerSeat('seat3', 'SIGTERM')

    await runSeat('seat4', false, async (seat) => {
      const { events, pty } = seat
      seat.attach('seat4rw', false)
      const spawned = await waitFor(async () => {
        const status = (await pty.status()) as { child?: { state?: string } }
        return status.child?.state === 'running'
      }, 15_000)
      await waitFor(
        () => /›|context left|gpt-/.test(capturePane('seat4rw', 'seat4.before-stop.pane.txt')),
        30_000
      )
      check('seat4 TUI running', spawned && seat.tuiSpawns() === 1, `spawns ${seat.tuiSpawns()}`)
      await seat.stop()
      const tuiGone = await waitFor(async () => {
        const status = (await pty.status()) as { child?: { state?: string } }
        return status.child?.state === 'exited'
      }, 10_000)
      const ended = await waitFor(
        () => events.some((event) => event.type === 'invocation.exited'),
        10_000
      )
      const status = (await pty.status()) as { child?: unknown }
      const remaining = processesOn(seat.appServerSocket)
      check(
        'seat4 stop ends the TUI and the app-server',
        tuiGone && ended && !alive(seat.appServerPid) && remaining.length === 0,
        `tui ${JSON.stringify(status.child)}, invocation.exited ${ended}, processes on socket ${JSON.stringify(remaining)}`
      )
    })
  } finally {
    tmux('kill-server')
    rmSync(work, { recursive: true, force: true })
    finish()
  }

  function finish(): void {
    const ok = checks.length > 0 && checks.every((entry) => entry.ok)
    writeFileSync(join(out, 'result.json'), `${JSON.stringify({ ok, checks }, null, 2)}\n`)
    writeFileSync(join(out, 'run.log'), `${logLines.join('\n')}\n`)
    process.exitCode = ok ? 0 : 1
  }
}

await main()
