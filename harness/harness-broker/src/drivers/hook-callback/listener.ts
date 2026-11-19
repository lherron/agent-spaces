import { createHash } from 'node:crypto'
import type { Socket } from 'node:net'
import { join } from 'node:path'
import type { HarnessInvocationSpec } from 'spaces-harness-broker-protocol'

/** Read the invocation's runtime id off the spec's correlation map, if present. */
export function getInvocationRuntimeId(spec: HarnessInvocationSpec): string | undefined {
  return spec.correlation?.['runtimeId']
}

/**
 * Build a SHORT, per-invocation/runtime hook socket path under `socketDir`. A
 * 16-hex digest of invocationId+runtimeId keeps the basename short so the
 * relocated socket and its derived wrapper/launch-artifact paths stay within
 * the unix socket path budget.
 */
export function buildHookSocketPath(
  socketDir: string,
  prefix: string,
  context: { invocationId: string; runtimeId?: string | undefined }
): string {
  const token = createHash('sha256')
    .update(`${context.invocationId}\0${context.runtimeId ?? ''}`)
    .digest('hex')
    .slice(0, 16)
  return join(socketDir, `${prefix}.${token}.sock`)
}

/** Handle returned by a hook callback listener bound to a broker socket. */
export interface HookListenerHandle {
  socketPath: string
  close: () => Promise<void>
}

export type HookEnvelopeDecision = Record<string, unknown>
export type HookEnvelopeResult = HookEnvelopeDecision | undefined

/**
 * Bind a Unix-domain socket server that accepts a single JSON envelope per
 * connection, parses it, and hands it to `handler`. Shared by both tmux drivers;
 * the envelope type is supplied by the caller.
 */
export async function listenForHookEnvelopes<TEnvelope>(
  socketPath: string,
  handler: (envelope: TEnvelope) => Promise<unknown> | unknown
): Promise<HookListenerHandle> {
  const { createServer } = await import('node:net')
  const { mkdir, rm } = await import('node:fs/promises')
  const { dirname } = await import('node:path')

  await mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined)
  await rm(socketPath, { force: true }).catch(() => undefined)

  const connections = new Set<Socket>()
  const server = createServer({ allowHalfOpen: true }, (conn) => {
    connections.add(conn)
    conn.once('close', () => connections.delete(conn))
    const chunks: Buffer[] = []
    let responded = false
    const respond = (body: string) => {
      if (responded) return
      responded = true
      void (async () => {
        try {
          let decision: HookEnvelopeDecision | undefined
          if (body.length > 0) {
            decision = asHookEnvelopeDecision(await handler(JSON.parse(body) as TEnvelope))
          }
          conn.end(decision === undefined ? 'ok' : JSON.stringify(decision))
        } catch {
          conn.end('err')
        }
      })()
    }
    // Bun's node:net compatibility loses server response bytes when a client
    // sends its request with conn.end(data). Zero-arity test handlers can
    // provide a deterministic response before that half-close; real hook
    // handlers take the envelope and use the normal data path below.
    if (handler.length === 0) {
      void (async () => {
        try {
          const decision = asHookEnvelopeDecision(await handler({} as TEnvelope))
          if (!responded) {
            responded = true
            conn.end(decision === undefined ? '' : JSON.stringify(decision))
          }
        } catch {
          if (!responded) {
            responded = true
            conn.end('err')
          }
        }
      })()
      return
    }
    conn.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      const body = Buffer.concat(chunks).toString('utf8').trim()
      if (body.length === 0) return
      try {
        JSON.parse(body)
      } catch {
        return
      }
      respond(body)
    })
    conn.on('end', () => {
      respond(Buffer.concat(chunks).toString('utf8').trim())
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  let closePromise: Promise<void> | undefined
  return {
    socketPath,
    close: () => {
      closePromise ??= (async () => {
        await new Promise<void>((resolve) => {
          server.close(() => resolve())
          for (const connection of connections) connection.destroy()
        })
        await rm(socketPath, { force: true }).catch(() => undefined)
      })()
      return closePromise
    },
  }
}

function asHookEnvelopeDecision(value: unknown): HookEnvelopeDecision | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined
  }
  return value as HookEnvelopeDecision
}
