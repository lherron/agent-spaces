import { existsSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { connect } from 'node:net'
import { platform } from 'node:os'

/**
 * Maximum bytes available for a Unix domain socket path (`sockaddr_un.sun_path`),
 * including the trailing NUL. macOS allots 104 bytes, Linux 108. Using the
 * smaller, platform-correct value lets the broker fail EARLY with a clear
 * message instead of surfacing a low-level `bind` errno.
 */
export const socketPathByteBudget = (): number => (platform() === 'linux' ? 108 : 104)

export const socketPathByteLength = (socketPath: string): number =>
  Buffer.byteLength(socketPath, 'utf8') + 1 // + trailing NUL

export class SocketPathTooLongError extends Error {
  constructor(socketPath: string, needed: number, budget: number) {
    super(
      `socket path too long: ${needed} bytes exceeds the ${budget}-byte platform limit (${socketPath})`
    )
    this.name = 'SocketPathTooLongError'
  }
}

/**
 * Throw {@link SocketPathTooLongError} when `socketPath` would not fit the
 * platform `sockaddr_un` budget. Run BEFORE any bind.
 */
export function assertSocketPathWithinBudget(socketPath: string): void {
  const budget = socketPathByteBudget()
  const needed = socketPathByteLength(socketPath)
  if (needed > budget) {
    throw new SocketPathTooLongError(socketPath, needed, budget)
  }
}

/** Probe an existing socket node and unlink it only if no live listener answers. */
export async function reclaimStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return
  }
  if (await probeSocketAlive(socketPath)) {
    process.stderr.write(`Broker socket already in use by a live listener: ${socketPath}\n`)
    process.exit(1)
  }
  await unlink(socketPath).catch(() => {})
}

function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect({ path: socketPath })
    const done = (alive: boolean): void => {
      probe.destroy()
      resolve(alive)
    }
    probe.once('connect', () => done(true))
    probe.once('error', () => done(false))
  })
}
