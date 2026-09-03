import { connect } from 'node:net'

export const HRC_MAIL_STOP_SOCKET_ENV = 'HRC_MAIL_STOP_SOCKET'

const MAIL_STOP_DECISION_PATH = '/v1/internal/mail/stop-decision'
const MAIL_STOP_QUERY_TIMEOUT_MS = 1_000
const MAIL_HINT_DECISION_PATH = '/v1/internal/mail/hint-decision'
const MAIL_HINT_QUERY_TIMEOUT_MS = 250

export type MailStopDecision = {
  decision: 'block'
  reason: string
}

export type MailHintDecision = {
  hint: string
  driveAttemptId: string
}

/**
 * Ask HRC whether the current runtime may finish its active turn.
 *
 * This query deliberately happens in the provider hook process before the Stop
 * envelope reaches the broker. Otherwise normalizing Stop would close the run
 * before HRC could resolve the stable current-turn record. Every failure is an
 * allow: a missing env seam, malformed response, timeout, or unavailable daemon
 * must never wedge an interactive agent.
 */
export async function queryMailStopDecision(
  hookData: unknown,
  env: Record<string, string | undefined>
): Promise<MailStopDecision | undefined> {
  if (getHookEventName(hookData) !== 'Stop') {
    return undefined
  }
  const socketPath = env[HRC_MAIL_STOP_SOCKET_ENV]
  const runtimeId = env['HARNESS_BROKER_RUNTIME_ID']
  if (socketPath === undefined || socketPath.length === 0 || runtimeId === undefined) {
    return undefined
  }

  try {
    const response = await postUnixHttpJson(
      socketPath,
      MAIL_STOP_DECISION_PATH,
      { runtimeId },
      MAIL_STOP_QUERY_TIMEOUT_MS
    )
    if (response.status !== 200) {
      return undefined
    }
    const parsed = JSON.parse(response.body) as unknown
    if (!isRecord(parsed) || parsed['decision'] !== 'block') {
      return undefined
    }
    const reason = parsed['reason']
    return typeof reason === 'string' && reason.length > 0
      ? { decision: 'block', reason }
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Ask HRC for count-only context about mail held behind this runtime's active
 * turn. PostToolUse is synchronous in Claude Code, so this path has a strict
 * 250 ms budget and every transport/protocol failure is silence.
 */
export async function queryMailHintDecision(
  hookData: unknown,
  env: Record<string, string | undefined>
): Promise<MailHintDecision | undefined> {
  if (getHookEventName(hookData) !== 'PostToolUse') {
    return undefined
  }
  const socketPath = env[HRC_MAIL_STOP_SOCKET_ENV]
  const runtimeId = env['HARNESS_BROKER_RUNTIME_ID']
  if (
    socketPath === undefined ||
    socketPath.length === 0 ||
    runtimeId === undefined ||
    runtimeId.length === 0
  ) {
    return undefined
  }

  try {
    const response = await postUnixHttpJson(
      socketPath,
      MAIL_HINT_DECISION_PATH,
      { runtimeId },
      MAIL_HINT_QUERY_TIMEOUT_MS
    )
    if (response.status !== 200) {
      return undefined
    }
    const parsed = JSON.parse(response.body) as unknown
    if (!isRecord(parsed)) return undefined
    const hint = parsed['hint']
    const driveAttemptId = parsed['driveAttemptId']
    return typeof hint === 'string' &&
      hint.length > 0 &&
      typeof driveAttemptId === 'string' &&
      driveAttemptId.length > 0
      ? { hint, driveAttemptId }
      : undefined
  } catch {
    return undefined
  }
}

export function getHookEventName(value: unknown): string | undefined {
  let current = value
  for (let depth = 0; depth < 4; depth += 1) {
    if (!isRecord(current)) return undefined
    const direct = current['hook_event_name']
    if (typeof direct === 'string') return direct
    current = current['hookEvent'] ?? current['payload'] ?? current['hookData']
  }
  return undefined
}

async function postUnixHttpJson(
  socketPath: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body)
  const request = [
    `POST ${path} HTTP/1.1`,
    'Host: localhost',
    'Content-Type: application/json',
    `Content-Length: ${Buffer.byteLength(payload)}`,
    'Connection: close',
    '',
    payload,
  ].join('\r\n')

  const raw = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    let settled = false
    const conn = connect(socketPath)
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      conn.destroy()
      reject(new Error('HRC mail stop query timed out'))
    }, timeoutMs)
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(Buffer.concat(chunks).toString('utf8'))
    }
    conn.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(error)
    })
    conn.on('data', (chunk: Buffer) => chunks.push(chunk))
    conn.on('end', finish)
    conn.on('close', finish)
    conn.on('connect', () => {
      conn.write(request)
    })
  })

  const separator = raw.indexOf('\r\n\r\n')
  if (separator === -1) throw new Error('Malformed HRC mail stop response')
  const head = raw.slice(0, separator)
  const statusMatch = /^HTTP\/1\.[01] (\d{3})\b/.exec(head)
  if (statusMatch?.[1] === undefined) throw new Error('Missing HRC mail stop status')
  return { status: Number(statusMatch[1]), body: raw.slice(separator + 4) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
