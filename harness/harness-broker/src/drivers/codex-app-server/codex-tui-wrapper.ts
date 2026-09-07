#!/usr/bin/env bun
import { type ChildProcess, spawn } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { connect } from 'node:net'
import { dirname, extname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

export interface AttachAttemptResult {
  code: number | null
  signal: NodeJS.Signals | null
  stderr: string
}

export interface CodexTuiAttachRetryOptions {
  launch: () => Promise<AttachAttemptResult>
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

interface WrapperArgs {
  command: string
  socketPath: string
  attachTokenPath: string
  controlSocketPath: string
  invocationId: string
  runtimeId?: string | undefined
}

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function parseArgs(): WrapperArgs {
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
  return {
    command,
    socketPath,
    attachTokenPath,
    controlSocketPath,
    invocationId,
    ...(runtimeId !== undefined ? { runtimeId } : {}),
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

async function killChild(child: ChildProcess | undefined): Promise<void> {
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([
    new Promise<void>((resolve) => child.once('exit', () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ])
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
}

async function run(): Promise<void> {
  const options = parseArgs()
  await rm(options.socketPath, { force: true }).catch(() => undefined)
  let tui: ChildProcess | undefined
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

  // The app-server's stderr carries codex's tracing output (ERROR level by
  // default). This wrapper runs inside the leased tmux `tui` pane, so an
  // inherited stderr would be the pane tty the codex TUI is painting on raw-mode:
  // every codex log line landed as a bare-`\n` staircase over the frame
  // (T-08232). Pipe it instead and hand each line to the driver over the control
  // socket, where it becomes an `info` diagnostic on the durable stream — the
  // same treatment the headless path gives app-server stderr.
  const appServer = spawn(
    options.command,
    ['app-server', '--listen', `unix://${options.socketPath}`],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    }
  )
  if (appServer.stderr) {
    createInterface({ input: appServer.stderr }).on('line', (line) => {
      if (line.trim().length === 0) return
      void postControl(options, { type: 'app-server-renderer.stderr', line })
    })
  }
  await writeFile(`${options.socketPath}.pid`, `${appServer.pid ?? ''}\n`, 'utf8')
  const serverExit = new Promise<never>((_resolve, reject) => {
    appServer?.once('error', reject)
    appServer?.once('exit', (code, signal) => {
      reject(new Error(`codex app-server exited before TUI (${signal ?? code ?? 'unknown'})`))
    })
  })
  serverExit.catch(() => {})

  const threadId = await Promise.race([waitForAttachToken(options.attachTokenPath), serverExit])
  const result = await runCodexTuiAttachRetry({
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

  await postControl(options, {
    type: result.code === 0 ? 'app-server-renderer.quit' : 'app-server-renderer.exited',
    ...(result.code === 0
      ? { reason: 'prompt_input_exit' }
      : { exitCode: result.code, signal: result.signal, detail: result.stderr }),
  })
  terminating = true
  await killChild(appServer)
  await rm(options.socketPath, { force: true }).catch(() => undefined)
  await rm(`${options.socketPath}.pid`, { force: true }).catch(() => undefined)
  process.exit(result.code ?? (result.signal === null ? 1 : 128))
}

if (import.meta.main) {
  await run().catch((error) => {
    process.stderr.write(
      `codex-tui wrapper failed: ${error instanceof Error ? error.message : String(error)}\n`
    )
    process.exit(1)
  })
}
