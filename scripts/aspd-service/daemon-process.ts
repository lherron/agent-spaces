/**
 * The daemon processes and their sockets, for both roles (Bun aspd, raspd):
 * detached spawn, "is this pid still that release's binary", readiness on the
 * socket under the expected release identity, and waiting for an exit.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import type { AspcHelloResponse } from 'spaces-aspc-protocol'
import { AspcServiceUnavailableError, AspcUnixClient } from 'spaces-aspc-protocol/unix-client'
import { type RunningRecord, fail, readJson } from './namespace.ts'

export const RETIRE_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 30_000

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The recorded process, only if its pid is still executing `program` from the recorded release. */
export function runningProcess(
  recordPath: string,
  program: 'aspd' | 'raspd'
): RunningRecord | undefined {
  const record = readJson<RunningRecord>(recordPath)
  if (record === undefined || !pidAlive(record.pid)) return undefined
  const command = spawnSync('ps', ['-o', 'command=', '-p', String(record.pid)], {
    encoding: 'utf8',
  }).stdout
  return command.includes(join(record.releasePath, 'libexec', program)) ||
    command.includes(join(record.releasePath, program))
    ? record
    : undefined
}

/** Spawn a daemon outside this process's lifetime, stdout and stderr appended to `logPath`. */
export function spawnDetached(
  name: string,
  launcher: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; logPath: string }
): number {
  const logFd = openSync(options.logPath, 'a')
  const child = spawn(launcher, args, {
    cwd: options.cwd,
    env: options.env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  })
  closeSync(logFd)
  if (child.pid === undefined) fail(`failed to spawn ${name}`)
  child.unref()
  return child.pid
}

export async function readback(
  socketPath: string
): Promise<AspcHelloResponse | { unavailable: string }> {
  try {
    const client = await AspcUnixClient.connect({
      socketPath,
      clientInfo: { name: 'aspd-service' },
      timeoutMs: 2_000,
    })
    const hello = client.hello
    await client.close()
    return hello
  } catch (error) {
    if (error instanceof AspcServiceUnavailableError) return { unavailable: error.message }
    throw error
  }
}

/** One version call on `socketPath`; undefined when nothing answers. */
export async function versionOf(socketPath: string): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolveVersion) => {
    const socket = createConnection({ path: socketPath })
    let buffer = ''
    const done = (value: Record<string, unknown> | undefined) => {
      socket.destroy()
      resolveVersion(value)
    }
    socket.setTimeout(2_000, () => done(undefined))
    socket.once('error', () => done(undefined))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      try {
        const reply = JSON.parse(buffer.slice(0, newline)) as { result?: Record<string, unknown> }
        done(reply.result)
      } catch {
        done(undefined)
      }
    })
    socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'version', params: {} })}\n`)
  })
}

/**
 * Poll `probe` every 100ms until it yields; `check` runs between polls (a dead
 * child fails fast) and `timeout` names the failure at the deadline.
 */
async function pollReady<T>(
  probe: () => Promise<T | undefined>,
  check: () => void,
  timeout: string
): Promise<T> {
  const deadline = Date.now() + READY_TIMEOUT_MS
  for (;;) {
    const ready = await probe()
    if (ready !== undefined) return ready
    check()
    if (Date.now() > deadline) fail(`${timeout} within ${READY_TIMEOUT_MS}ms`)
    await Bun.sleep(100)
  }
}

/** Wait for the socket to answer as `releaseId`; a different identity is a failure. */
export function awaitServing(
  socketPath: string,
  releaseId: string,
  check: () => void = () => undefined
): Promise<AspcHelloResponse> {
  return pollReady(
    async () => {
      const hello = await readback(socketPath)
      if ('unavailable' in hello) return undefined
      if (hello.release?.releaseId !== releaseId) {
        fail(
          `socket answered as ${hello.release?.releaseId ?? '(unidentified)'}, expected ${releaseId}`
        )
      }
      return hello
    },
    check,
    `aspd did not answer as ${releaseId}`
  )
}

/** Wait until the public socket answers as raspd fronting `releaseId`. */
export function awaitFrontDoor(
  socketPath: string,
  releaseId: string,
  check: () => void = () => undefined
): Promise<Record<string, unknown>> {
  return pollReady(
    async () => {
      const version = await versionOf(socketPath)
      const front = version?.['frontDoor'] as { name?: unknown } | undefined
      const release = version?.['release'] as { releaseId?: unknown } | undefined
      if (front?.name !== 'raspd') return undefined
      if (release?.releaseId !== releaseId) {
        fail(`raspd answered as ${String(release?.releaseId)}, expected ${releaseId}`)
      }
      return version as Record<string, unknown>
    },
    check,
    `raspd did not answer on ${socketPath}`
  )
}

export async function awaitPidExit(pid: number | undefined): Promise<void> {
  if (pid === undefined) return
  const deadline = Date.now() + RETIRE_TIMEOUT_MS + 5_000
  while (pidAlive(pid)) {
    if (Date.now() > deadline) fail(`previous aspd pid ${pid} did not exit`)
    await Bun.sleep(50)
  }
}
