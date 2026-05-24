/**
 * Redaction — scrubs secrets and sensitive content from event payloads.
 *
 * Rules:
 * 1. Env values must never appear in serialized event JSON.
 * 2. Authorization headers, Bearer tokens, and *-Token patterns are redacted.
 * 3. Attachment binary content is stripped; only paths are visible.
 */

import type { DiagnosticPayload, InvocationEventType } from 'spaces-harness-broker-protocol'

const REDACTED = '[REDACTED]'
const TRUNCATED = '[TRUNCATED]'

// Patterns that match header/token values in strings.
const AUTH_BEARER_RE = /Authorization:\s*Bearer\s+\S+/gi
const GENERIC_TOKEN_RE = /[A-Za-z0-9-]*Token:\s*\S+/gi
const BARE_BEARER_RE = /Bearer\s+[A-Za-z0-9_\-./+=]{8,}/gi

/** Build a set of env value strings to scrub (excludes empty/trivially short). */
export function buildEnvSecrets(env: Record<string, string> | undefined): Set<string> {
  const secrets = new Set<string>()
  if (!env) return secrets
  for (const value of Object.values(env)) {
    if (value.length > 0) {
      secrets.add(value)
    }
  }
  return secrets
}

/** Replace all occurrences of each secret within a string. */
function scrubString(text: string, secrets: Set<string>): string {
  let result = text
  for (const secret of secrets) {
    if (result.includes(secret)) {
      result = result.split(secret).join(REDACTED)
    }
  }
  // Redact auth headers and tokens
  result = result.replace(AUTH_BEARER_RE, `Authorization: ${REDACTED}`)
  result = result.replace(GENERIC_TOKEN_RE, REDACTED)
  result = result.replace(BARE_BEARER_RE, `Bearer ${REDACTED}`)
  return result
}

/**
 * Deep-walk a JSON-serializable value and scrub any string that contains
 * an env secret or an auth/token pattern.
 */
export function redactPayload(value: unknown, secrets: Set<string>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return scrubString(value, secrets)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (Array.isArray(value)) return value.map((v) => redactPayload(v, secrets))
  if (typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = redactPayload(v, secrets)
    }
    return result
  }
  return value
}

/**
 * Produce a redaction-safe view of a permission request subject.
 *
 * The subject originates from the harness process (e.g. a Codex command
 * approval request) and may carry env secrets — both as an `env` map and
 * inlined into other fields (e.g. a command line). This is used for BOTH the
 * `permission.requested` audit event (`subjectRedacted`) and the broker→client
 * `invocation.permission.request` payload, so neither path can leak secrets.
 *
 * Rules:
 * 1. Any value found in the subject's own `env` map is treated as a secret and
 *    scrubbed from every string in the subject.
 * 2. Provided `envSecrets` (the invocation's process env) are also scrubbed.
 * 3. The `env` block itself is never exposed; it is replaced with `[REDACTED]`.
 */
export function redactPermissionSubject(subject: unknown, envSecrets?: Set<string>): unknown {
  const secrets = new Set<string>(envSecrets ?? [])
  if (subject !== null && typeof subject === 'object' && !Array.isArray(subject)) {
    const env = (subject as Record<string, unknown>)['env']
    if (env !== null && typeof env === 'object') {
      for (const value of Object.values(env as Record<string, unknown>)) {
        if (typeof value === 'string' && value.length > 0) {
          secrets.add(value)
        }
      }
    }
  }

  const scrubbed = redactPayload(subject, secrets)

  if (scrubbed !== null && typeof scrubbed === 'object' && !Array.isArray(scrubbed)) {
    const record = scrubbed as Record<string, unknown>
    if ('env' in record) {
      return { ...record, env: REDACTED }
    }
  }
  return scrubbed
}

/**
 * Constrain `invocation.started` payloads to only contain safe fields:
 * pid, command, args, cwd.
 */
export function safeStartedPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload
  const p = payload as Record<string, unknown>
  const safe: Record<string, unknown> = {}
  if (p['pid'] !== undefined) safe['pid'] = p['pid']
  if (p['command'] !== undefined) safe['command'] = p['command']
  if (p['args'] !== undefined) safe['args'] = p['args']
  if (p['cwd'] !== undefined) safe['cwd'] = p['cwd']
  return safe
}

export interface FinalizeEventPayloadInput {
  type: InvocationEventType
  payload: unknown
  envSecrets: Set<string>
  maxEventBytes?: number | undefined
}

export interface FinalizeEventPayloadResult {
  payload: unknown
  diagnostics?: DiagnosticPayload[] | undefined
}

/**
 * Single central event-safety path applied by the invocation manager before an
 * event is sequenced and notified. Composes every payload-safety rule so there
 * is exactly one place that decides what leaves the broker:
 *
 * 1. Constrain `invocation.started` to {pid, command, args, cwd}.
 * 2. Normalize final-contract terminal payloads (`invocation.ready`,
 *    `invocation.disposed`) to their canonical shape regardless of emitter.
 * 3. Scrub env-secret values AND auth/bearer/token patterns (always — even when
 *    there are no env secrets).
 * 4. Redact permission subjects in `permission.requested` audit events.
 * 5. Truncate oversized payloads deterministically against `maxEventBytes`,
 *    emitting a broker diagnostic describing what was truncated.
 *
 * Returns the safe payload plus any diagnostics the manager should emit as
 * follow-on events. Truncation is preferred over failing the invocation.
 */
export function finalizeEventPayload(input: FinalizeEventPayloadInput): FinalizeEventPayloadResult {
  const { type, payload, envSecrets, maxEventBytes } = input

  // 1 + 2. Constrain / normalize well-known payload shapes.
  let safe: unknown = payload
  if (type === 'invocation.started') {
    safe = safeStartedPayload(payload)
  } else if (type === 'invocation.ready') {
    safe = { state: 'ready' }
  } else if (type === 'invocation.disposed') {
    safe = { disposed: true }
  }

  // 3. Scrub env secrets and auth/bearer/token patterns. Always runs so that
  // token patterns are redacted even when the invocation has no env secrets.
  safe = redactPayload(safe, envSecrets)

  // 4. Defense-in-depth permission subject redaction.
  if (
    type === 'permission.requested' &&
    safe !== null &&
    typeof safe === 'object' &&
    !Array.isArray(safe) &&
    'subjectRedacted' in (safe as Record<string, unknown>)
  ) {
    const record = safe as Record<string, unknown>
    safe = {
      ...record,
      subjectRedacted: redactPermissionSubject(record['subjectRedacted'], envSecrets),
    }
  }

  // 5. Deterministic size enforcement.
  if (maxEventBytes !== undefined && maxEventBytes > 0) {
    const result = truncateToBudget(safe, maxEventBytes)
    if (result.truncatedPaths.length > 0) {
      const diagnostic: DiagnosticPayload = {
        level: 'warn',
        message: `Event payload for ${type} exceeded maxEventBytes (${maxEventBytes}); truncated field(s): ${result.truncatedPaths.join(', ')}`,
        source: 'broker',
        data: {
          eventType: type,
          maxEventBytes,
          truncatedFields: result.truncatedPaths,
        },
      }
      return { payload: result.payload, diagnostics: [diagnostic] }
    }
  }

  return { payload: safe }
}

interface TruncateResult {
  payload: unknown
  truncatedPaths: string[]
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

/**
 * Greedily replace the largest string leaves with `[TRUNCATED]` until the
 * serialized payload fits within `maxBytes`. Replacing a string with a shorter
 * string never invalidates other leaf paths, so candidates can be collected
 * once and applied in a stable (size desc, path asc) order — keeping the
 * behavior deterministic. If the payload cannot be serialized at all it is
 * replaced with a safe marker rather than crashing the broker.
 */
function truncateToBudget(payload: unknown, maxBytes: number): TruncateResult {
  let serialized: string
  try {
    serialized = JSON.stringify(payload) ?? 'null'
  } catch {
    return {
      payload: { error: 'unserializable_payload', note: TRUNCATED },
      truncatedPaths: ['<payload>'],
    }
  }

  if (byteLength(serialized) <= maxBytes) {
    return { payload, truncatedPaths: [] }
  }

  const clone = JSON.parse(serialized) as unknown
  const leaves: { path: string[]; len: number }[] = []
  collectStringLeaves(clone, [], leaves)
  leaves.sort((a, b) => b.len - a.len || a.path.join('.').localeCompare(b.path.join('.')))

  const truncatedPaths: string[] = []
  for (const leaf of leaves) {
    setAtPath(clone, leaf.path, TRUNCATED)
    truncatedPaths.push(leaf.path.length > 0 ? leaf.path.join('.') : '<payload>')
    if (byteLength(JSON.stringify(clone) ?? 'null') <= maxBytes) {
      break
    }
  }

  return { payload: clone, truncatedPaths }
}

function collectStringLeaves(
  value: unknown,
  path: string[],
  out: { path: string[]; len: number }[]
): void {
  if (typeof value === 'string') {
    out.push({ path, len: value.length })
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectStringLeaves(item, [...path, String(index)], out))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      collectStringLeaves(child, [...path, key], out)
    }
  }
}

function setAtPath(root: unknown, path: string[], replacement: unknown): void {
  if (path.length === 0) return
  let cursor = root as Record<string, unknown>
  for (let i = 0; i < path.length - 1; i += 1) {
    cursor = cursor[path[i] as string] as Record<string, unknown>
  }
  cursor[path[path.length - 1] as string] = replacement
}

/** @deprecated Phase 1 stub — use redactPayload + buildEnvSecrets instead. */
export function redactEnv(_payload: unknown): unknown {
  return _payload
}

/** @deprecated Phase 1 stub — use redactPayload + buildEnvSecrets instead. */
export function redactSecrets(_text: string): string {
  return _text
}
