import { realpathSync } from 'node:fs'
import { parseHookJson, postEnvelopeAndRead, readAll } from '../hook-bridge-transport'
import { parseHookDecision } from '../hook-callback/decision'
import { type HookEnvelope, buildHookEnvelopeFromEnv } from '../hook-callback/envelope'
import { asRecord, getString } from '../hook-json'

export const SEAT_DIRECTORY_ENV = 'HARNESS_BROKER_SEAT_DIRECTORY'
export const WORKSPACE_MISMATCH = 'antigravity_workspace_mismatch'
const CALLBACK_SOCKET_ENV = 'HARNESS_BROKER_CALLBACK_SOCKET'
const CALLBACK_TIMEOUT_MS = 500

export type AntigravityHookEnvelope = Omit<HookEnvelope, 'hookData' | 'hookEventName'> & {
  event: string
  payload: Record<string, unknown>
  startedAt: number
  workspaceMismatch?: { expected?: string | undefined; actual?: string | undefined } | undefined
}

function fallbackFor(event: string): Record<string, unknown> {
  if (event === 'PreToolUse') return { decision: 'allow' }
  if (event === 'Stop') return { decision: 'stop' }
  return {}
}

function acceptsReply(event: string, reply: Record<string, unknown>): boolean {
  if (event === 'PreToolUse' || event === 'Stop') {
    const decision = reply['decision']
    if (decision === (event === 'PreToolUse' ? 'allow' : 'stop')) return true
    return (
      decision === (event === 'PreToolUse' ? 'deny' : 'continue') &&
      typeof reply['reason'] === 'string' &&
      reply['reason'].length > 0
    )
  }
  if (Object.keys(reply).length === 0) return true
  return (
    event === 'PreInvocation' &&
    Array.isArray(reply['injectSteps']) &&
    reply['injectSteps'].every((step: unknown) => {
      const value = asRecord(step)
      return (
        typeof value['userMessage'] === 'string' || typeof value['ephemeralMessage'] === 'string'
      )
    })
  )
}

function sameDirectory(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || actual === undefined) return false
  if (expected === actual) return true
  try {
    return realpathSync(expected) === realpathSync(actual)
  } catch {
    return false
  }
}

async function forward(
  envelope: AntigravityHookEnvelope
): Promise<Record<string, unknown> | undefined> {
  const response = await postEnvelopeAndRead(envelope.callbackSocket, envelope, {
    timeoutMs: CALLBACK_TIMEOUT_MS,
  })
  return parseHookDecision(response, (reply) => acceptsReply(envelope.event, reply))
}

export async function runAntigravityHookBridgeCli(args: string[]): Promise<void> {
  // process.uptime includes startup before the CLI imports completed. Compare
  // hooks and status by when the bridge started, independent of socket order.
  const startedAt = Date.now() - process.uptime() * 1_000
  const eventIndex = args.indexOf('--event')
  const eventOverride = eventIndex === -1 ? undefined : args[eventIndex + 1]
  const env = process.env
  let event = eventOverride ?? ''
  try {
    const payload = asRecord(parseHookJson(await readAll(process.stdin)))
    event = eventOverride ?? getString(payload, 'hookEventName') ?? ''
    const socketPath = env[CALLBACK_SOCKET_ENV]
    const expected = env[SEAT_DIRECTORY_ENV]
    const actual = getString(payload, 'cwd')
    const mismatch =
      event === 'PreInvocation' &&
      (expected !== undefined || Boolean(socketPath)) &&
      !sameDirectory(expected, actual)
        ? { expected, actual }
        : undefined
    if (mismatch !== undefined) {
      process.stdout.write(
        JSON.stringify({
          terminationBehavior: 'terminate',
          injectSteps: [{ errorMessage: { userMessage: WORKSPACE_MISMATCH } }],
        })
      )
    }

    if (socketPath) {
      const reply = await (async () => {
        const { hookData: _hookData, ...binding } = buildHookEnvelopeFromEnv(payload, env)
        return forward({
          ...binding,
          event,
          payload,
          startedAt,
          ...(mismatch !== undefined ? { workspaceMismatch: mismatch } : {}),
        })
      })().catch(() => undefined)
      if (mismatch === undefined) {
        process.stdout.write(JSON.stringify(reply ?? fallbackFor(event)))
      }
      return
    }
    if (mismatch !== undefined) return
  } catch {
    // A malformed request or missing binding leaves the event's explicit fallback.
  }
  process.stdout.write(JSON.stringify(fallbackFor(event)))
}
