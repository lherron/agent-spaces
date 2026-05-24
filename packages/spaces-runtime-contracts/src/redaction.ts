import type { RedactedValue } from 'spaces-harness-broker-protocol'
import type { SecretDigest } from './hash'
import { createCanonicalHasher } from './hash'

export type {
  RedactedHarnessInvocationSpec,
  RedactedInvocationStartRequest,
  RedactedValue,
} from 'spaces-harness-broker-protocol'

export type RedactionState = 'none' | 'redacted' | 'contains-secret-digests'

export type RedactedArtifact<T = unknown> = {
  schemaVersion: string
  redactionState: RedactionState
  hash: string
  value: T
}

export type RedactionDigestCarrier = {
  digest?: SecretDigest | undefined
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export type RedactOptions = {
  env?: Record<string, string | undefined> | undefined
}

const SECRET_PLACEHOLDER = '[REDACTED:secret]'
const TOKEN_PLACEHOLDER = '[REDACTED:token]'

/** Bearer / token / authToken patterns embedded inside string values. */
const BEARER_PATTERN = /(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi
const AUTH_TOKEN_PATTERN = /(_authToken=)[^\s"']+/gi
const GENERIC_TOKEN_QUERY = /([?&](?:access_token|token|api_key|apikey)=)[^&\s"']+/gi

/** CLI flags whose following positional argument carries a secret value. */
const SECRET_FLAG = /^-{1,2}.*(token|key|secret|password|passwd|auth|credential|bearer)/i

function collectSecretValues(env?: Record<string, string | undefined>): string[] {
  if (!env) return []
  const values: string[] = []
  for (const value of Object.values(env)) {
    if (typeof value === 'string' && value.length > 0) values.push(value)
  }
  // Longest first so overlapping secrets redact greedily.
  return values.sort((a, b) => b.length - a.length)
}

type RedactionContext = {
  secretValues: string[]
  changed: boolean
}

function redactString(input: string, ctx: RedactionContext): string {
  let out = input
  for (const secret of ctx.secretValues) {
    if (out.includes(secret)) {
      out = out.split(secret).join(SECRET_PLACEHOLDER)
    }
  }
  out = out
    .replace(BEARER_PATTERN, `$1${TOKEN_PLACEHOLDER}`)
    .replace(AUTH_TOKEN_PATTERN, `$1${TOKEN_PLACEHOLDER}`)
    .replace(GENERIC_TOKEN_QUERY, `$1${TOKEN_PLACEHOLDER}`)
  if (out !== input) ctx.changed = true
  return out
}

function redactNode(value: unknown, ctx: RedactionContext): RedactedValue {
  if (value === null) return null
  if (typeof value === 'string') return redactString(value, ctx)
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'boolean') return value
  if (typeof value === 'bigint') return value.toString()

  if (Array.isArray(value)) {
    const result: RedactedValue[] = []
    for (let i = 0; i < value.length; i += 1) {
      const element = value[i]
      if (
        typeof element === 'string' &&
        SECRET_FLAG.test(element) &&
        i + 1 < value.length &&
        typeof value[i + 1] === 'string'
      ) {
        result.push(redactNode(element, ctx))
        result.push(TOKEN_PLACEHOLDER)
        ctx.changed = true
        i += 1 // consume the redacted value following the flag
        continue
      }
      result.push(redactNode(element, ctx))
    }
    return result
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    const result: { [key: string]: RedactedValue } = {}
    for (const key of Object.keys(record)) {
      const child = record[key]
      if (child === undefined) continue
      result[key] = redactNode(child, ctx)
    }
    return result
  }

  // functions / symbols / undefined are not representable — drop to null.
  return null
}

/**
 * Scrub env-secret values, bearer/token patterns, and secret CLI flag args from
 * an arbitrary value, returning a `RedactedValue` with stable `[REDACTED:...]`
 * placeholders. No raw secret survives into the result.
 */
export function redactValue(value: unknown, options?: RedactOptions): RedactedValue {
  const ctx: RedactionContext = {
    secretValues: collectSecretValues(options?.env),
    changed: false,
  }
  return redactNode(value, ctx)
}

/**
 * Produce a `RedactedArtifact` whose `hash` is the canonical hash of the
 * redacted value, computed under the `redacted-placeholder` secret mode so the
 * stored hash matches a recomputation of the redacted payload.
 */
export function redactArtifact<T = unknown>(
  value: T,
  options?: RedactOptions
): RedactedArtifact<RedactedValue> {
  const ctx: RedactionContext = {
    secretValues: collectSecretValues(options?.env),
    changed: false,
  }
  const redacted = redactNode(value, ctx)
  const hash = createCanonicalHasher().hash(redacted, {
    secretMode: 'redacted-placeholder',
    timestampMode: 'include-semantic',
  }).value
  return {
    schemaVersion: 'redacted-artifact/v1',
    redactionState: ctx.changed ? 'redacted' : 'none',
    hash,
    value: redacted,
  }
}
