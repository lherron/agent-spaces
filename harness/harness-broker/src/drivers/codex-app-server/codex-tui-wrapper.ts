#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  type HrcptyOpsConnection,
  connectHrcptyOps,
  defaultHrcptyTokenFile,
} from '../../runtime/hrcpty'

export interface AttachAttemptResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

export interface CodexTuiAttachRetryOptions {
  launch: () => Promise<AttachAttemptResult>
  /** Whether a failed attempt is worth another; absent retries until the deadline. */
  retryable?: ((result: AttachAttemptResult) => Promise<boolean>) | undefined
  timeoutMs?: number | undefined
  initialBackoffMs?: number | undefined
  maxBackoffMs?: number | undefined
  now?: (() => number) | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
}

/** Bounded retry for the zero-rollout (-32600) and metadata (-32603) attach race. */
export async function runCodexTuiAttachRetry(
  options: CodexTuiAttachRetryOptions
): Promise<AttachAttemptResult> {
  const timeoutMs = options.timeoutMs ?? 30_000
  const maxBackoffMs = options.maxBackoffMs ?? 2_000
  const now = options.now ?? Date.now
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = now() + timeoutMs
  let backoffMs = options.initialBackoffMs ?? 250
  let last: AttachAttemptResult = { code: 1, signal: null, stderr: 'attach was not attempted' }
  while (now() <= deadline) {
    last = await options.launch()
    if (last.code === 0 || last.signal !== null) return last
    if (options.retryable !== undefined && !(await options.retryable(last))) return last
    if (now() + backoffMs > deadline) break
    await sleep(backoffMs)
    backoffMs = Math.min(maxBackoffMs, backoffMs * 2)
  }
  return last
}

export function resolveCodexTuiWrapperEntryPath(): string {
  const self = fileURLToPath(import.meta.url)
  return join(dirname(self), `codex-tui-wrapper${extname(self)}`)
}

/**
 * T-08556: an executable that carries the codex-tui wrapper and the codex hook
 * receiver as subcommands. A standalone ASP release passes its own payload
 * (`<execPath>`) so the TUI wrapper and hook receiver run from the same release
 * as the worker; inside a bun-compiled release the wrapper entry file does not
 * exist (`/$bunfs/root/codex-tui-wrapper`).
 */
export interface CodexTuiLauncher {
  command: string
}

/** The argv prefix that runs the wrapper: `<launcher> codex-tui-wrapper` or `<execPath> <entry>`. */
export function buildCodexTuiWrapperArgvPrefix(
  launcher: CodexTuiLauncher | undefined,
  execPath: string = process.execPath
): string[] {
  return launcher !== undefined
    ? [launcher.command, 'codex-tui-wrapper']
    : [execPath, resolveCodexTuiWrapperEntryPath()]
}

/** The shell command the generated hook bridge runs to reach the codex hook receiver. */
export function buildCodexTuiHookReceiverArgv(
  launcher: CodexTuiLauncher | undefined,
  callbackSocket: string
): string[] {
  return [launcher?.command ?? 'harness-broker', 'codex-hook', '--socket', callbackSocket]
}

interface WrapperArgs {
  command: string
  socketPath: string
  attachTokenPath: string
  controlSocketPath: string
  invocationId: string
  runtimeId?: string | undefined
  /**
   * hrcpty seats (T-12162 §4.1): the broker owns the app-server, so the
   * wrapper neither spawns, removes nor kills it; it only runs the TUI.
   */
  attachOnly: boolean
  /** File the driver writes the thread's rollout path to (attach-only). */
  rolloutMarkerPath?: string | undefined
}

function parseArgs(argv: readonly string[]): WrapperArgs {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const command = flag('--command')
  const socketPath = flag('--socket')
  const attachTokenPath = flag('--attach-token')
  const controlSocketPath = flag('--control-socket')
  const invocationId = flag('--invocation-id')
  if (!command || !socketPath || !attachTokenPath || !controlSocketPath || !invocationId) {
    throw new Error(
      'codex-tui wrapper requires --command, --socket, --attach-token, --control-socket, and --invocation-id'
    )
  }
  const runtimeId = flag('--runtime-id')
  const rolloutMarkerPath = flag('--rollout-marker')
  return {
    command,
    socketPath,
    attachTokenPath,
    controlSocketPath,
    invocationId,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
    attachOnly: argv.includes('--attach-only'),
    ...(rolloutMarkerPath !== undefined ? { rolloutMarkerPath } : {}),
  }
}

async function waitForAttachToken(path: string): Promise<string> {
  for (;;) {
    try {
      const token = (await readFile(path, 'utf8')).trim()
      if (token.length > 0) return token
    } catch {
      // The broker writes the token only after start/resume and resume scrub.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }
}

async function readRolloutMarker(path: string | undefined): Promise<string | undefined> {
  if (path === undefined) return undefined
  try {
    const rollout = (await readFile(path, 'utf8')).trim()
    return rollout.length > 0 ? rollout : undefined
  } catch {
    return undefined
  }
}

/**
 * Read-write clients on the hrc-pty supervisor this wrapper runs under
 * (`HRC_PTY_SOCKET`, token beside it). Undefined when there is no supervisor
 * or it cannot be asked; the caller treats that as attached.
 */
function createReadWriteProbe(): () => Promise<number | undefined> {
  const socketPath = process.env['HRC_PTY_SOCKET']
  let open: Promise<HrcptyOpsConnection> | undefined
  return async () => {
    if (socketPath === undefined || socketPath.length === 0) return undefined
    try {
      open ??= (async () => {
        const connection = await connectHrcptyOps(socketPath)
        const token = (await readFile(defaultHrcptyTokenFile(socketPath), 'utf8')).trim()
        await connection.call('hello', { token })
        return connection
      })()
      const status = (await (await open).call('status')) as {
        clients?: { readWrite?: unknown }
      }
      const readWrite = status.clients?.readWrite
      return typeof readWrite === 'number' ? readWrite : undefined
    } catch {
      void open?.then((connection) => connection.close()).catch(() => undefined)
      open = undefined
      return undefined
    }
  }
}

/**
 * hrcpty seats (T-12166): Codex creates the rollout on the thread's first user
 * message, and `resume` fails with -32600 until then. Wait, without a
 * deadline, until the rollout exists and a read-write client is attached, so
 * the TUI's terminal probe still meets a live terminal. Showing one dim line
 * instead of an attach-retry error loop.
 */
async function waitForTuiLaunchGate(
  rolloutPath: string | undefined,
  socketPath: string
): Promise<'launch' | 'server-gone'> {
  const readWriteClients = createReadWriteProbe()
  let shown = false
  for (let poll = 0; ; poll++) {
    const rolloutReady = rolloutPath === undefined || existsSync(rolloutPath)
    const readWrite = await readWriteClients()
    if (rolloutReady && (readWrite === undefined || readWrite > 0)) return 'launch'
    // No turn can come from a server that is gone; stop waiting on it.
    if (poll % 8 === 7 && !(await appServerReachable(socketPath))) return 'server-gone'
    if (!shown && !rolloutReady) {
      process.stdout.write('\x1b[2mcodex: waiting for the first turn\u2026\x1b[0m\r\n')
      shown = true
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
}

async function postControl(options: WrapperArgs, envelope: Record<string, unknown>): Promise<void> {
  await new Promise<void>((resolve) => {
    const socket = connect(options.controlSocketPath, () => {
      socket.end(
        JSON.stringify({
          ...envelope,
          invocationId: options.invocationId,
          ...(options.runtimeId !== undefined ? { runtimeId: options.runtimeId } : {}),
          callbackSocket: options.controlSocketPath,
        })
      )
    })
    socket.once('error', () => resolve())
    socket.once('close', () => resolve())
  })
}

/** Whether something still accepts connections on the app-server's unix socket. */
export async function appServerReachable(socketPath: string, timeoutMs = 1_000): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = connect(socketPath)
    const timer = setTimeout(() => {
      socket.destroy()
      resolve(false)
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
  })
}

async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

/** Run the wrapper with its flags (`harness-broker codex-tui-wrapper …` or the entry file). */
export async function runCodexTuiWrapper(argv: readonly string[]): Promise<void> {
  const options = parseArgs(argv)
  let tui: ChildProcess | undefined
  let appServer: ChildProcess | undefined
  let terminating = false
  const terminate = async (signal: NodeJS.Signals): Promise<void> => {
    if (terminating) return
    terminating = true
    await killChild(tui)
    await killChild(appServer)
    process.exit(signal === 'SIGHUP' ? 129 : 143)
  }
  process.on('SIGHUP', () => void terminate('SIGHUP'))
  process.on('SIGTERM', () => void terminate('SIGTERM'))
  // Codex 0.163 quits on one Ctrl-C at an empty composer and then restores
  // cooked mode, so a second Ctrl-C right behind it is a SIGINT to the
  // terminal's foreground group, this wrapper included. Dying there would skip
  // the quit envelope and leave the seat up (T-12162 D3).
  process.on('SIGINT', () => undefined)

  let serverExit: Promise<never> | undefined
  if (!options.attachOnly) {
    // Paint one line the instant we start. The broker submits the launch command
    // with a confirm loop that re-presses Enter every 1.5s (up to five times)
    // until the pane no longer ends with the command text, and that loop cannot
    // tell a silent program from a swallowed Enter. This wrapper stays silent for
    // seconds (app-server spawn, broker thread/start, attach token) while every
    // extra Enter queues in the pane tty and lands as blank lines in the codex
    // TUI's input box once it takes the terminal. Advancing the pane here is
    // what every other tmux harness does by printing its banner.
    process.stdout.write('\x1b[2mcodex tui: starting app-server\u2026\x1b[0m\n')
    await rm(options.socketPath, { force: true }).catch(() => undefined)
    // The app-server's stderr carries codex's tracing output (ERROR level by
    // default). This wrapper runs inside the leased tmux `tui` pane, so an
    // inherited stderr would be the pane tty the codex TUI is painting on raw-mode:
    // every codex log line landed as a bare-`\n` staircase over the frame
    // (T-08232). Pipe it instead and hand each line to the driver over the control
    // socket, where it becomes an `info` diagnostic on the durable stream — the
    // same treatment the headless path gives app-server stderr.
    const server = spawn(
      options.command,
      ['app-server', '--listen', `unix://${options.socketPath}`],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    )
    appServer = server
    if (server.stderr) {
      createInterface({ input: server.stderr }).on('line', (line) => {
        if (line.trim().length === 0) return
        void postControl(options, { type: 'app-server-renderer.stderr', line })
      })
    }
    await writeFile(`${options.socketPath}.pid`, `${server.pid ?? ''}\n`, 'utf8')
    serverExit = new Promise<never>((_resolve, reject) => {
      server.once('error', reject)
      server.once('exit', (code, signal) => {
        reject(new Error(`codex app-server exited before TUI (${signal ?? code ?? 'unknown'})`))
      })
    })
    serverExit.catch(() => {})
  }

  const threadId =
    serverExit === undefined
      ? await waitForAttachToken(options.attachTokenPath)
      : await Promise.race([waitForAttachToken(options.attachTokenPath), serverExit])
  if (
    options.attachOnly &&
    (await waitForTuiLaunchGate(
      await readRolloutMarker(options.rolloutMarkerPath),
      options.socketPath
    )) === 'server-gone'
  ) {
    await postControl(options, {
      type: 'app-server-renderer.exited',
      exitCode: null,
      signal: null,
      detail: 'app-server gone before the first turn',
    })
    process.exit(1)
  }
  const result = await runCodexTuiAttachRetry({
    // The attach race retries against a live server; a gone one never answers.
    ...(options.attachOnly ? { retryable: () => appServerReachable(options.socketPath) } : {}),
    launch: () =>
      new Promise<AttachAttemptResult>((resolve, reject) => {
        const stderr: Buffer[] = []
        tui = spawn(
          options.command,
          ['--remote', `unix://${options.socketPath}`, 'resume', threadId],
          {
            cwd: process.cwd(),
            env: process.env,
            stdio: ['inherit', 'inherit', 'pipe'],
          }
        )
        tui.stderr?.on('data', (chunk: Buffer) => {
          stderr.push(chunk)
          process.stderr.write(chunk)
        })
        tui.once('error', reject)
        tui.once('exit', (code, signal) =>
          resolve({ code, signal, stderr: Buffer.concat(stderr).toString('utf8') })
        )
      }),
  })

  // Codex 0.163's remote TUI exits 0 both on a quit and when it loses its
  // server ("Disconnected from this task"). Only a quit with the server still
  // up is the user's quit; the other ends the TUI, never the conversation.
  const serverUp = options.attachOnly
    ? await appServerReachable(options.socketPath)
    : appServer !== undefined && appServer.exitCode === null && appServer.signalCode === null
  // A SIGINT reaches the TUI only once it has restored cooked mode on its
  // way out of a Ctrl-C quit (a second Ctrl-C right behind the first).
  const quit = (result.code === 0 || result.signal === 'SIGINT') && serverUp
  await postControl(options, {
    type: quit ? 'app-server-renderer.quit' : 'app-server-renderer.exited',
    ...(quit
      ? { reason: 'prompt_input_exit' }
      : { exitCode: result.code, signal: result.signal, detail: result.stderr }),
  })
  terminating = true
  if (!options.attachOnly) {
    await killChild(appServer)
    await rm(options.socketPath, { force: true }).catch(() => undefined)
    await rm(`${options.socketPath}.pid`, { force: true }).catch(() => undefined)
  }
  process.exit(result.code ?? (result.signal === null ? 1 : 128))
}

if (import.meta.main) {
  await runCodexTuiWrapper(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `codex-tui wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  })
}
