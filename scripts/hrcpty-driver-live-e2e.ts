#!/usr/bin/env bun

/**
 * T-12050: the claude-code-hrcpty driver against a real `hrc-pty serve`.
 *
 * A script child stands in for Claude: it draws a `❯ ` input box at the
 * cursor row, takes a bracketed paste into the box, records each body it is
 * given on `\r`, clears on Ctrl-U, and on an interrupt puts the last body back
 * in the box, as Claude does after an early interrupt (T-12046 §4.5). The run
 * proves, through the real ops socket:
 *
 *   spawn      the driver spawned the child with Claude's argv (`--settings`
 *              overlay) and env (`HARNESS_BROKER_*`); hrc-pty set TERM
 *   input      each turn reached the child as one bracketed paste plus `\r`,
 *              byte-exact, including a 2 KB multi-line body
 *   capture    the driver confirmed every submit from `capture`'s cursor row
 *   interrupt  after the driver's interrupt, the restored body was cleared
 *              with Ctrl-U, so the next turn did not append to it
 *
 * A missing binary is a failure, not a skip.
 *
 *   bun scripts/hrcpty-driver-live-e2e.ts --out <dir> [--hrc-pty <binary>]
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  HarnessInvocationSpec,
  InvocationEventEnvelope,
  InvocationInput,
} from 'spaces-harness-broker-protocol'

import { createDefaultClaudeCodeHrcptyDriver } from '../harness/harness-broker/src/drivers/claude-code-hrcpty/driver'
import type { DriverContext } from '../harness/harness-broker/src/drivers/driver'
import { HrcptyPtyController } from '../harness/harness-broker/src/runtime/hrcpty'
import {
  resolveHrcptyBinary,
  startHrcptySupervisor,
} from '../harness/harness-broker/src/testing/hrcpty-supervisor'

const FAKE_CLAUDE = String.raw`
import json, os, sys, termios, time, tty

out = sys.argv[1]
json.dump({"argv": sys.argv, "env": dict(os.environ)}, open(os.path.join(out, "child.json"), "w"))
received = open(os.path.join(out, "received.ndjson"), "a")
fd = sys.stdin.fileno()
tty.setraw(fd)
box, log, last = "", [], ""

def draw():
    rows, cols = os.get_terminal_size(fd).lines, os.get_terminal_size(fd).columns
    shown = log[-(rows - 3):]
    sys.stdout.write("\x1b[2J\x1b[H")
    sys.stdout.write("fake-claude (hrc-pty live test)\r\n")
    for line in shown:
        sys.stdout.write(line[: cols - 1] + "\r\n")
    sys.stdout.write("\x1b[%d;1H\x1b[2K❯ %s" % (rows - 1, box))
    sys.stdout.flush()

def record(kind, body):
    received.write(json.dumps({"kind": kind, "body": body}) + "\n")
    received.flush()

draw()
buf = b""
while True:
    chunk = os.read(fd, 65536)
    if not chunk:
        break
    buf += chunk
    while buf:
        if buf.startswith(b"\x1b[200~"):
            end = buf.find(b"\x1b[201~")
            if end < 0:
                break
            body = buf[6:end].decode()
            buf = buf[end + 6:]
            box += "[Pasted text #1 +%d lines]" % body.count("\n") if "\n" in body else body
            pending = body
            record("paste", body)
        else:
            ch, buf = buf[:1], buf[1:]
            if ch == b"\r":
                if box:
                    record("submit", box)
                    log.append("submitted %d chars" % len(box))
                    last, box = box, ""
            elif ch == b"\x15":
                record("ctrl-u", box)
                box = ""
            elif ch == b"\x03":
                record("interrupt", last)
                draw()
                time.sleep(0.5)
                box = last
            else:
                box += ch.decode(errors="replace")
    draw()
`

type Check = { name: string; ok: boolean; detail: string }

function parseArgs(argv: string[]): { out: string; binary: string | undefined } {
  let out: string | undefined
  let binary: string | undefined
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i]
    else if (argv[i] === '--hrc-pty') binary = argv[++i]
  }
  if (out === undefined)
    throw new Error('usage: hrcpty-driver-live-e2e.ts --out <dir> [--hrc-pty <binary>]')
  return { out, binary: binary ?? resolveHrcptyBinary() }
}

function multiLineBody(): string {
  const lines: string[] = ['T-12050 live multi-line prompt, line 1']
  for (let i = 2; lines.join('\n').length < 2048; i++) {
    lines.push(`line ${i}: the quick brown fox jumps over the lazy dog`)
  }
  return lines.join('\n')
}

function input(inputId: string, text: string): InvocationInput {
  return { inputId, kind: 'user', content: [{ type: 'text', text }] } as InvocationInput
}

async function main(): Promise<void> {
  const { out, binary } = parseArgs(process.argv.slice(2))
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
  const finish = (): void => {
    const ok = checks.length > 0 && checks.every((entry) => entry.ok)
    writeFileSync(
      join(out, 'result.json'),
      `${JSON.stringify({ ok, binary: binary ?? null, checks }, null, 2)}\n`
    )
    writeFileSync(join(out, 'run.log'), `${logLines.join('\n')}\n`)
    process.exitCode = ok ? 0 : 1
  }

  if (binary === undefined) {
    check('hrc-pty binary', false, 'not found (set HRC_PTY_BIN or pass --hrc-pty)')
    finish()
    return
  }
  log(`hrc-pty binary ${binary}`)

  // Short on purpose: the ops socket path must fit sockaddr_un.
  const scratch = mkdtempSync(join(tmpdir(), 'hpl-'))
  const childOut = join(scratch, 'child')
  mkdirSync(childOut)
  const childScript = join(scratch, 'fake-claude.py')
  writeFileSync(childScript, FAKE_CLAUDE)
  const supervisor = await startHrcptySupervisor({
    binary,
    dir: join(scratch, 'ipc'),
    cols: 100,
    rows: 30,
    runtimeId: 'runtime_hrcpty_live',
  })
  log(`hrc-pty serve pid ${supervisor.pid} on ${supervisor.socketPath}`)

  const events: InvocationEventEnvelope[] = []
  const ctx: DriverContext = {
    invocationId: 'inv_hrcpty_live' as DriverContext['invocationId'],
    clientCapabilities: {},
    runtime: { terminalSurface: supervisor.lease },
    emit(type, payload, extra) {
      const event = {
        invocationId: 'inv_hrcpty_live',
        seq: events.length + 1,
        time: new Date().toISOString(),
        type,
        payload,
        ...extra,
      } as InvocationEventEnvelope
      events.push(event)
      return event as never
    },
    emitEvent(event, extra) {
      const envelope = {
        invocationId: 'inv_hrcpty_live',
        seq: events.length + 1,
        time: new Date().toISOString(),
        ...event,
        ...extra,
      } as InvocationEventEnvelope
      events.push(envelope)
      return envelope
    },
  }
  const spec = {
    specVersion: 'harness-broker.invocation/v1',
    invocationId: 'inv_hrcpty_live',
    harness: { frontend: 'claude-code', provider: 'anthropic', driver: 'claude-code-hrcpty' },
    process: {
      command: 'python3',
      args: [childScript, childOut],
      cwd: scratch,
      lockedEnv: { HRCPTY_LIVE_MARKER: 'T-12050' },
      harnessTransport: { kind: 'pty' },
      limits: { startupTimeoutMs: 10_000, turnTimeoutMs: 10_000, stopGraceMs: 500 },
    },
    interaction: { mode: 'interactive', turnConcurrency: 'single', inputQueue: 'fifo' },
    driver: { kind: 'claude-code-hrcpty', terminalHost: 'hrcpty' },
    correlation: { hostSessionId: 'host_hrcpty_live', runtimeId: 'runtime_hrcpty_live' },
  } as unknown as HarnessInvocationSpec

  // The driver's default token source: attach.token beside the leased socket.
  const driver = createDefaultClaudeCodeHrcptyDriver(join(scratch, 'hooks'))
  const observer = new HrcptyPtyController({
    socketPath: supervisor.socketPath,
    allowedOps: supervisor.lease.allowedOps,
  })
  const bodies = ['hello from the hrc-pty live test', multiLineBody(), 'after the interrupt']
  try {
    await driver.start(spec, ctx)
    const status = (await observer.status()) as { child?: { state?: string; pid?: number } }
    check('spawn', status.child?.state === 'running', `child ${JSON.stringify(status.child)}`)

    const surface = events.find((event) => event.type === 'terminal.surface.reported')
    check(
      'terminal surface',
      JSON.stringify(surface?.payload) ===
        JSON.stringify({ kind: 'hrcpty-socket', socketPath: supervisor.socketPath }) &&
        surface?.driver?.kind === 'claude-code-hrcpty',
      JSON.stringify({ payload: surface?.payload, driver: surface?.driver })
    )

    const first = await driver.applyInputNow(input('input_live_1', bodies[0] as string))
    log(`turn 1 delivered (${first.turnId})`)
    const second = await driver.applyInputNow(input('input_live_2', bodies[1] as string))
    log(`turn 2 delivered (${second.turnId}), ${(bodies[1] as string).length} chars`)
    const interrupted = await driver.interrupt({
      invocationId: 'inv_hrcpty_live' as never,
      scope: 'turn',
    })
    log(`interrupt ${JSON.stringify(interrupted)}`)
    const third = await driver.applyInputNow(input('input_live_3', bodies[2] as string))
    log(`turn 3 delivered (${third.turnId})`)

    const capture = await observer.captureRaw()
    writeFileSync(join(out, 'capture.json'), `${JSON.stringify(capture, null, 2)}\n`)
    check(
      'capture',
      capture.text.includes('fake-claude (hrc-pty live test)') &&
        (capture.text.split('\n')[capture.cursor.y] ?? '').startsWith('❯') &&
        capture.cursor.x === 2,
      `cursor ${JSON.stringify(capture.cursor)}, row "${capture.text.split('\n')[capture.cursor.y]}"`
    )

    const child = JSON.parse(readFileSync(join(childOut, 'child.json'), 'utf8')) as {
      argv: string[]
      env: Record<string, string>
    }
    const settingsIndex = child.argv.indexOf('--settings')
    const settings =
      settingsIndex === -1
        ? undefined
        : (JSON.parse(readFileSync(child.argv[settingsIndex + 1] as string, 'utf8')) as {
            hooks?: Record<string, unknown>
          })
    check(
      'spawn argv',
      settings?.hooks?.['UserPromptSubmit'] !== undefined && settings.hooks['Stop'] !== undefined,
      `argv ${JSON.stringify(child.argv.slice(1))}`
    )
    const env = child.env
    check(
      'spawn env',
      env['HARNESS_BROKER_INVOCATION_ID'] === 'inv_hrcpty_live' &&
        env['HARNESS_BROKER_RUNTIME_ID'] === 'runtime_hrcpty_live' &&
        (env['HARNESS_BROKER_CALLBACK_SOCKET'] ?? '').startsWith(join(scratch, 'hooks')) &&
        env['HRCPTY_LIVE_MARKER'] === 'T-12050' &&
        env['TERM'] === 'xterm-ghostty' &&
        env['TERM_PROGRAM'] === 'ghostty' &&
        env['TMUX'] === undefined,
      JSON.stringify({
        HARNESS_BROKER_INVOCATION_ID: env['HARNESS_BROKER_INVOCATION_ID'],
        HARNESS_BROKER_CALLBACK_SOCKET: env['HARNESS_BROKER_CALLBACK_SOCKET'],
        TERM: env['TERM'],
        TERM_PROGRAM: env['TERM_PROGRAM'],
        TERM_PROGRAM_VERSION: env['TERM_PROGRAM_VERSION'],
        TMUX: env['TMUX'] ?? null,
      })
    )

    const received = readFileSync(join(childOut, 'received.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; body: string })
    writeFileSync(
      join(out, 'received.ndjson'),
      `${received.map((r) => JSON.stringify(r)).join('\n')}\n`
    )
    const pastes = received.filter((entry) => entry.kind === 'paste').map((entry) => entry.body)
    check(
      'bracketed input',
      JSON.stringify(pastes) === JSON.stringify(bodies),
      `${pastes.length} pastes, byte-exact: ${pastes.map((body, i) => body === bodies[i]).join(',')}`
    )
    const submits = received.filter((entry) => entry.kind === 'submit').map((entry) => entry.body)
    check(
      'submit',
      submits.length === 3 &&
        submits[0] === bodies[0] &&
        /^\[Pasted text #1 \+\d+ lines\]$/.test(submits[1] ?? '') &&
        submits[2] === bodies[2],
      JSON.stringify(submits)
    )
    const order = received.map((entry) => entry.kind)
    const interruptAt = order.indexOf('interrupt')
    check(
      'interrupt clearing',
      interrupted.accepted &&
        interruptAt > 0 &&
        order[interruptAt + 1] === 'ctrl-u' &&
        received[interruptAt + 1]?.body === submits[1] &&
        order[interruptAt + 2] === 'paste',
      `sequence after interrupt: ${JSON.stringify(order.slice(interruptAt))}`
    )
  } catch (error) {
    check('run', false, error instanceof Error ? (error.stack ?? error.message) : String(error))
  } finally {
    observer.close()
    await driver.dispose().catch(() => undefined)
    await supervisor.shutdown()
    writeFileSync(
      join(out, 'events.ndjson'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
    )
    try {
      writeFileSync(
        join(out, 'hrcpty.log'),
        readFileSync(join(scratch, 'ipc', 'hrcpty.log'), 'utf8')
      )
    } catch {
      // No supervisor log.
    }
    rmSync(scratch, { recursive: true, force: true })
    finish()
  }
}

await main()
