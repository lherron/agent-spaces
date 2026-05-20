/**
 * Redaction — scrubs secrets and sensitive content from event payloads.
 *
 * Rules:
 * 1. Env values must never appear in serialized event JSON.
 * 2. Authorization headers, Bearer tokens, and *-Token patterns are redacted.
 * 3. Attachment binary content is stripped; only paths are visible.
 */

const REDACTED = '[REDACTED]'

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

/** @deprecated Phase 1 stub — use redactPayload + buildEnvSecrets instead. */
export function redactEnv(_payload: unknown): unknown {
  return _payload
}

/** @deprecated Phase 1 stub — use redactPayload + buildEnvSecrets instead. */
export function redactSecrets(_text: string): string {
  return _text
}
