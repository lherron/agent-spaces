import { connect as netConnect } from 'node:net'

const UNIX_SCHEME = 'unix://'
const HTTPS_DEFAULT_PORT = 443
const HTTP_DEFAULT_PORT = 80

interface ParsedTcpEndpoint {
  kind: 'tcp'
  host: string
  port: number
}

interface ParsedUnixEndpoint {
  kind: 'unix'
  path: string
}

type ParsedEndpoint = ParsedTcpEndpoint | ParsedUnixEndpoint

/**
 * Parse a service endpoint string into a TCP host/port or a unix socket path.
 * Returns `undefined` for unsupported protocols. Recognized forms:
 * - `unix:///path` or an absolute `/path` → unix socket
 * - `tcp://`, `http(s)://`, `ws(s)://` URLs → TCP, defaulting the port to
 *   443 for the secure schemes and 80 otherwise.
 */
export function parseServiceEndpoint(endpoint: string): ParsedEndpoint | undefined {
  if (endpoint.startsWith(UNIX_SCHEME)) {
    return { kind: 'unix', path: endpoint.slice(UNIX_SCHEME.length) }
  }
  if (endpoint.startsWith('/')) {
    return { kind: 'unix', path: endpoint }
  }
  try {
    const url = new URL(endpoint)
    if (
      url.protocol === 'tcp:' ||
      url.protocol === 'http:' ||
      url.protocol === 'https:' ||
      url.protocol === 'ws:' ||
      url.protocol === 'wss:'
    ) {
      const isSecure = url.protocol === 'https:' || url.protocol === 'wss:'
      const port = url.port ? Number(url.port) : isSecure ? HTTPS_DEFAULT_PORT : HTTP_DEFAULT_PORT
      return { kind: 'tcp', host: url.hostname, port }
    }
  } catch {
    return undefined
  }
  return undefined
}

/**
 * Attempt a TCP/unix-socket connection to `endpoint` and resolve `true` if it
 * succeeds within `timeoutMs`. Connection errors and timeouts resolve `false`
 * (intentionally swallowed — a probe only reports reachability, never throws).
 */
export function probeServiceEndpoint(endpoint: string, timeoutMs: number): Promise<boolean> {
  const parsed = parseServiceEndpoint(endpoint)
  if (!parsed) return Promise.resolve(false)
  return new Promise((resolve) => {
    const sock =
      parsed.kind === 'unix'
        ? netConnect(parsed.path)
        : netConnect({ host: parsed.host, port: parsed.port })
    let settled = false
    const finish = (up: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      sock.destroy()
      resolve(up)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

/** Strip the `unix://` scheme prefix for display purposes. */
export function displayServiceEndpoint(endpoint: string): string {
  return endpoint.startsWith(UNIX_SCHEME) ? endpoint.slice(UNIX_SCHEME.length) : endpoint
}
