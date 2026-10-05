import { existsSync } from 'node:fs'
import { type Socket, connect } from 'node:net'
import { formatError, readFlag } from './cli-args'

// ---------------------------------------------------------------------------
// Operator capture surface (T-07853 §6.1)
// ---------------------------------------------------------------------------

export const CAPTURE_USAGE = `
Usage: harness-broker capture <status|release> --socket <path> --invocation <id> [options]

  status   Show an invocation's capture state and every unclassified native type it
           has seen, with a repeat count per (driver, nativeType, family).
             harness-broker capture status --socket <path> --invocation <id> [--json]

  release  RETAINED, and a no-op since T-07883: the normalization cursor never halts,
           so no record is ever the blocked-unknown record and every release is
           refused by naming that. Kept on the wire for the fleet still calling it.
             harness-broker capture release --socket <path> --invocation <id> \\
               --raw-record <id> --disposition ignored-known [--note <text>]
             harness-broker capture release --socket <path> --invocation <id> \\
               --raw-record <id> --disposition normalized-as \\
               --event-type <invocation event type> --event-payload <json> [--turn-id <id>]

  --disposition ignored-known  the native type is real but intentionally outside the
                               broker vocabulary; nothing is minted for it.
  --disposition normalized-as  the operator authors the normalized event the broker
                               could not derive; it is committed with the blocked
                               record's provenance.
`

export const SUBMISSION_USAGE = `
Usage: harness-broker submission withdraw <submissionId> --socket <path> --reason <text>
       harness-broker submission withdraw --envelope <envelopeId> --socket <path> --reason <text>
`

export async function submissionCommand(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub !== 'withdraw') {
    process.stderr.write(`Unknown submission subcommand: ${sub ?? '(none)'}\n${SUBMISSION_USAGE}`)
    process.exit(1)
  }
  const submissionId = args[1]?.startsWith('--') === false ? args[1] : undefined
  const envelopeId = readFlag(args, '--envelope')
  const socketPath = readFlag(args, '--socket')
  const reason = readFlag(args, '--reason')
  if (
    (submissionId === undefined) === (envelopeId === undefined) ||
    socketPath === undefined ||
    reason === undefined
  ) {
    process.stderr.write(
      `submission withdraw requires exactly one selector (submissionId or --envelope), --socket, and --reason\n${SUBMISSION_USAGE}`
    )
    process.exit(1)
    return
  }

  try {
    const call = await connectControlClient(socketPath)
    const response = await call('submission.withdraw', {
      ...(submissionId !== undefined ? { submissionId } : { envelopeId }),
      reason,
    })
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exitCode = 1
  }
}

export async function captureCommand(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub !== 'status' && sub !== 'release') {
    process.stderr.write(`Unknown capture subcommand: ${sub ?? '(none)'}\n${CAPTURE_USAGE}`)
    process.exit(1)
  }
  const socketPath = readFlag(args, '--socket')
  const invocationId = readFlag(args, '--invocation')
  if (socketPath === undefined || invocationId === undefined) {
    process.stderr.write(`capture ${sub} requires --socket and --invocation\n${CAPTURE_USAGE}`)
    process.exit(1)
    return
  }

  try {
    const call = await connectControlClient(socketPath)
    if (sub === 'status') {
      // Capture state rides the ordinary snapshot rather than a second read
      // surface, so the operator sees it in the same place a controller does. `probeLiveness` is deliberately not requested: reading capture
      // state must not poke the harness process.
      const snapshot = (await call('invocation.snapshot', { invocationId })) as {
        capture?: unknown
      }
      const capture = snapshot.capture ?? { state: 'open', deferredCount: 0 }
      if (args.includes('--json')) {
        process.stdout.write(`${JSON.stringify(capture, null, 2)}\n`)
      } else {
        process.stdout.write(`${formatCaptureState(capture)}\n`)
      }
      return
    }

    const rawRecordId = readFlag(args, '--raw-record')
    const disposition = readFlag(args, '--disposition')
    if (rawRecordId === undefined) {
      process.stderr.write(`capture release requires --raw-record\n${CAPTURE_USAGE}`)
      process.exit(1)
      return
    }
    if (disposition !== 'ignored-known' && disposition !== 'normalized-as') {
      process.stderr.write(
        `capture release requires --disposition ignored-known|normalized-as\n${CAPTURE_USAGE}`
      )
      process.exit(1)
      return
    }

    const note = readFlag(args, '--note')
    let normalizedAs: Record<string, unknown> | undefined
    if (disposition === 'normalized-as') {
      const eventType = readFlag(args, '--event-type')
      const payloadJson = readFlag(args, '--event-payload')
      if (eventType === undefined || payloadJson === undefined) {
        process.stderr.write(
          `capture release --disposition normalized-as requires --event-type and --event-payload\n${CAPTURE_USAGE}`
        )
        process.exit(1)
        return
      }
      const turnId = readFlag(args, '--turn-id')
      normalizedAs = {
        type: eventType,
        payload: JSON.parse(payloadJson) as unknown,
        ...(turnId !== undefined ? { turnId } : {}),
      }
    }

    const response = await call('invocation.capture.release', {
      invocationId,
      rawRecordId,
      disposition,
      ...(normalizedAs !== undefined ? { normalizedAs } : {}),
      ...(note !== undefined ? { note } : {}),
    })
    process.stdout.write(`${JSON.stringify(response, null, 2)}\n`)
  } catch (err) {
    process.stderr.write(`${formatError(err)}\n`)
    process.exitCode = 1
  }
}

function formatCaptureState(capture: unknown): string {
  const view = capture as {
    state?: string
    blockedUnknown?: Array<{
      driver?: string
      nativeType?: string
      family?: string
      loadBearing?: boolean
      count?: number
      message?: string
    }>
  }
  // `state` is always `open` on a T-07883 broker. What an operator actually
  // needs from this command is the unclassified types the seat has seen, which
  // are otherwise only in broker.err and the ndjson stream.
  const lines = [`capture: ${view.state ?? 'open'}`]
  for (const entry of view.blockedUnknown ?? []) {
    lines.push(
      `  blocked_unknown x${entry.count ?? 1}${entry.loadBearing === true ? ' [load-bearing]' : ''}`,
      `    driver:     ${entry.driver ?? '(unknown)'}`,
      `    nativeType: ${entry.nativeType ?? '(unknown)'}`,
      `    family:     ${entry.family ?? '(unknown)'}`,
      `    message:    ${entry.message ?? ''}`
    )
  }
  return lines.join('\n')
}

/**
 * A failed connect to the operator socket. Its message is the one line the CLI
 * prints, naming the socket path, so a missing, stale or unreadable socket
 * never surfaces as a raw runtime stack (T-10321).
 */
export class BrokerSocketConnectError extends Error {
  readonly socketPath: string
  readonly code: string | undefined

  constructor(socketPath: string, cause: unknown) {
    const code = (cause as { code?: unknown } | null)?.code
    // Bun reports ENOENT for a stale socket file with no listener too, so the
    // path's existence picks the wording rather than the code alone.
    const reason =
      code === 'ENOENT' && !existsSync(socketPath)
        ? 'no socket at that path'
        : code === 'ENOENT' || code === 'ECONNREFUSED'
          ? 'connection refused (no broker listening)'
          : code === 'EACCES' || code === 'EPERM'
            ? 'permission denied'
            : cause instanceof Error
              ? cause.message
              : String(cause)
    super(`cannot connect to broker socket ${socketPath}: ${reason}`)
    this.name = 'BrokerSocketConnectError'
    this.socketPath = socketPath
    this.code = typeof code === 'string' ? code : undefined
  }
}

/**
 * Minimal one-shot NDJSON JSON-RPC client for the operator subcommands. It does
 * NOT attach: `invocation.capture.release` is a control-connection method, and
 * attaching would fence the live HRC controller off its own runtime.
 */
async function connectControlClient(
  socketPath: string
): Promise<(method: string, params: unknown) => Promise<unknown>> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const s = connect({ path: socketPath })
    s.once('connect', () => resolve(s))
    s.once('error', (error) => reject(new BrokerSocketConnectError(socketPath, error)))
  })
  let nextId = 1
  let buffer = ''
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      if (line.trim().length === 0) continue
      let frame: { id?: number; result?: unknown; error?: { message?: string; data?: unknown } }
      try {
        frame = JSON.parse(line) as typeof frame
      } catch {
        continue
      }
      if (typeof frame.id !== 'number') continue
      const pending = waiting.get(frame.id)
      if (pending === undefined) continue
      waiting.delete(frame.id)
      socket.end()
      if (frame.error !== undefined) {
        const detail = frame.error.data !== undefined ? `: ${JSON.stringify(frame.error.data)}` : ''
        pending.reject(new Error(`${frame.error.message ?? 'broker error'}${detail}`))
      } else {
        pending.resolve(frame.result)
      }
    }
  })

  return (method: string, params: unknown) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextId++
      waiting.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
}
