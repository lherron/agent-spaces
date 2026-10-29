import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { InvocationRuntimeContext } from 'spaces-harness-broker-protocol'
import { connectHrcptyOps } from '../runtime/hrcpty'

/**
 * A hand-started `hrc-pty serve` in the position rusthrc gives it (T-12046
 * §5 step 2), for tests, the admission matrix and smokes that have no HRC:
 * its socket and attach token in one directory, and the hrcpty lease the
 * broker's dispatch would carry.
 */
export type HrcptySupervisor = {
  binary: string
  socketPath: string
  token: string
  pid: number
  lease: NonNullable<InvocationRuntimeContext['terminalSurface']>
  /** `shutdown` on the ops socket (§4.6); the child gets TERM, then KILL after 5 s. */
  shutdown: () => Promise<void>
}

/** `HRC_PTY_BIN`, else a cargo build in the canonical hrc-runtime checkout, else PATH. */
export function resolveHrcptyBinary(): string | undefined {
  const crates = join(homedir(), 'praesidium', 'hrc-runtime', 'crates', 'target')
  const candidates = [
    process.env['HRC_PTY_BIN'],
    join(crates, 'release', 'hrc-pty'),
    join(crates, 'debug', 'hrc-pty'),
  ]
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.length > 0 && existsSync(candidate)) return candidate
  }
  const onPath = Bun.which('hrc-pty')
  return onPath !== null && onPath.length > 0 ? onPath : undefined
}

/**
 * Start `hrc-pty serve` with its socket at `<dir>/hrcpty.sock`. `dir` must be
 * short: the socket path has to fit sockaddr_un. `serve` returns once the
 * socket is bound, so the supervisor is ready when this resolves.
 */
export async function startHrcptySupervisor(options: {
  binary: string
  dir: string
  cols?: number | undefined
  rows?: number | undefined
  runtimeId?: string | undefined
  brokerArgv?: string[] | undefined
}): Promise<HrcptySupervisor> {
  mkdirSync(options.dir, { recursive: true, mode: 0o700 })
  const socketPath = join(options.dir, 'hrcpty.sock')
  const token = randomBytes(16).toString('hex')
  writeFileSync(join(options.dir, 'attach.token'), `${token}\n`, { mode: 0o600 })
  const argv = [
    'serve',
    '--socket',
    socketPath,
    '--cols',
    String(options.cols ?? 120),
    '--rows',
    String(options.rows ?? 40),
    ...(options.runtimeId !== undefined ? ['--runtime-id', options.runtimeId] : []),
    ...(options.brokerArgv !== undefined ? ['--broker-argv', ...options.brokerArgv] : []),
  ]
  const { code, stdout, stderr } = await new Promise<{
    code: number | null
    stdout: string
    stderr: string
  }>((resolve, reject) => {
    const proc = spawn(options.binary, argv, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    proc.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8')
    })
    proc.stderr.on('data', (chunk: Buffer) => {
      err += chunk.toString('utf8')
    })
    proc.on('error', reject)
    proc.on('close', (exit) => resolve({ code: exit, stdout: out, stderr: err }))
  })
  if (code !== 0) {
    throw new Error(`hrc-pty serve exited ${code}: ${stderr.trim() || stdout.trim()}`)
  }
  const pid = Number(stdout.trim().split('\n').at(-1))
  return {
    binary: options.binary,
    socketPath,
    token,
    pid,
    lease: {
      kind: 'hrcpty',
      ownership: 'hrc',
      socketPath,
      allowedOps: {
        inspect: true,
        sendInput: true,
        sendInterrupt: true,
        capture: true,
        resize: false,
        spawn: true,
      },
    },
    shutdown: async () => {
      try {
        const connection = await connectHrcptyOps(socketPath)
        await connection.call('hello', { token })
        await connection.call('shutdown')
        connection.close()
      } catch {
        if (Number.isSafeInteger(pid) && pid > 0) {
          try {
            process.kill(pid, 'SIGTERM')
          } catch {
            // Already gone.
          }
        }
      }
      const deadline = Date.now() + 7_000
      while (Date.now() < deadline && existsSync(socketPath)) await Bun.sleep(50)
    },
  }
}
