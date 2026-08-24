import { platform } from 'node:os'
import { BrokerTransportError } from './errors'

/**
 * Maximum bytes available for a Unix domain socket path (`sockaddr_un.sun_path`),
 * including the trailing NUL. macOS allots 104 bytes, Linux 108. We use the
 * smaller, platform-correct value so an over-long path fails EARLY with a clear
 * message instead of surfacing a low-level `bind`/`connect` errno.
 */
export const socketPathByteBudget = (): number => (platform() === 'linux' ? 108 : 104)

export const socketPathByteLength = (socketPath: string): number =>
  Buffer.byteLength(socketPath, 'utf8') + 1 // + trailing NUL

/**
 * Throw a readable "socket path too long" error when `socketPath` would not fit
 * the platform `sockaddr_un` budget. Callers run this BEFORE any bind/connect.
 */
export function assertSocketPathWithinBudget(socketPath: string): void {
  const budget = socketPathByteBudget()
  const needed = socketPathByteLength(socketPath)
  if (needed > budget) {
    throw new BrokerTransportError(
      `Broker socket path too long: ${needed} bytes exceeds the ${budget}-byte platform limit (${socketPath})`
    )
  }
}
