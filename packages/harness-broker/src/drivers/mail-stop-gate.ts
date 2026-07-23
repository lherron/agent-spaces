import { connect } from 'node:net'

export const HRC_MAIL_STOP_SOCKET_ENV = 'HRC_MAIL_STOP_SOCKET'

const MAIL_STOP_DECISION_PATH = '/v1/internal/mail/stop-decision'
const MAIL_STOP_QUERY_TIMEOUT_MS = 1_000

export type MailStopDecision = {
  decision: 'block'
  reason: string
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
    const response = await postUnixHttpJson(socketPath, MAIL_STOP_DECISION_PATH, { runtimeId })
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

function getHookEventName(value: unknown): string | undefined {
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
  body: Record<string, unknown>
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
    }, MAIL_STOP_QUERY_TIMEOUT_MS)
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
