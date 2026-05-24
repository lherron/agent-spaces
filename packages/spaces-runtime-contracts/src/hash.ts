export type HashAlgorithm = 'sha256-canonical-json/v1'

export type CanonicalHash = {
  algorithm: HashAlgorithm
  value: string
}

export type SecretDigest = {
  algorithm: 'hmac-sha256-secret-digest/v1' | 'compiler-scoped-secret-digest/v1'
  value: string
  scope?: string | undefined
}

export type SecretRef = {
  key: string
  classification: 'secret'
  digest: SecretDigest
}

export type HashMaterialPolicy = {
  omitFields: string[]
  secretMode: 'digest' | 'redacted-placeholder'
  timestampMode: 'omit-ephemeral' | 'include-semantic'
}

export interface CanonicalHasher {
  canonicalize(value: unknown, policy?: Partial<HashMaterialPolicy>): string
  hash(value: unknown, policy?: Partial<HashMaterialPolicy>): CanonicalHash
}

// ---------------------------------------------------------------------------
// Implementation (sha256-canonical-json/v1)
// ---------------------------------------------------------------------------

import { createHash, createHmac } from 'node:crypto'

const CANONICAL_ALGORITHM: HashAlgorithm = 'sha256-canonical-json/v1'

const DEFAULT_POLICY: HashMaterialPolicy = {
  omitFields: [],
  secretMode: 'digest',
  timestampMode: 'include-semantic',
}

/**
 * Field names treated as ephemeral timestamps and dropped when
 * `timestampMode === 'omit-ephemeral'`. Matches camelCase (`createdAt`),
 * snake_case (`updated_at`) and explicit timestamp suffixes.
 */
const EPHEMERAL_TIMESTAMP_FIELD = /(?:_at|At|_ts|Ts|timestamp|Timestamp)$/

function isEphemeralTimestampField(key: string): boolean {
  return EPHEMERAL_TIMESTAMP_FIELD.test(key)
}

function resolvePolicy(policy?: Partial<HashMaterialPolicy>): HashMaterialPolicy {
  return {
    omitFields: policy?.omitFields ?? DEFAULT_POLICY.omitFields,
    secretMode: policy?.secretMode ?? DEFAULT_POLICY.secretMode,
    timestampMode: policy?.timestampMode ?? DEFAULT_POLICY.timestampMode,
  }
}

function isSecretRef(value: unknown): value is SecretRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { classification?: unknown }).classification === 'secret' &&
    typeof (value as { digest?: unknown }).digest === 'object' &&
    (value as { digest?: { value?: unknown } }).digest !== null &&
    typeof (value as { digest: { value?: unknown } }).digest.value === 'string'
  )
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`canonical hash forbids non-finite number: ${String(value)}`)
  }
  return JSON.stringify(value)
}

function serialize(value: unknown, policy: HashMaterialPolicy): string {
  if (value === null) return 'null'

  const type = typeof value
  if (type === 'string') return JSON.stringify(value)
  if (type === 'boolean') return value ? 'true' : 'false'
  if (type === 'number') return serializeNumber(value as number)
  if (type === 'bigint') return JSON.stringify((value as bigint).toString())
  if (type === 'undefined' || type === 'function' || type === 'symbol') {
    // Callers omit undefined object fields before recursing; reaching here
    // (e.g. an array hole) serializes to null to mirror JSON semantics.
    return 'null'
  }

  // Secrets are represented exclusively by their digest — never any raw value.
  if (isSecretRef(value)) {
    if (policy.secretMode === 'redacted-placeholder') {
      return JSON.stringify('[REDACTED:secret]')
    }
    return serialize(
      {
        classification: value.classification,
        key: value.key,
        secretDigest: value.digest.value,
        secretDigestAlgorithm: value.digest.algorithm,
        secretDigestScope: value.digest.scope,
      },
      policy
    )
  }

  if (Array.isArray(value)) {
    const items = value.map((item) => (item === undefined ? 'null' : serialize(item, policy)))
    return `[${items.join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    if (policy.omitFields.includes(key)) continue
    if (policy.timestampMode === 'omit-ephemeral' && isEphemeralTimestampField(key)) {
      continue
    }
    const child = record[key]
    if (child === undefined) continue // omit undefined; null is preserved
    parts.push(`${JSON.stringify(key)}:${serialize(child, policy)}`)
  }
  return `{${parts.join(',')}}`
}

export function createCanonicalHasher(): CanonicalHasher {
  return {
    canonicalize(value: unknown, policy?: Partial<HashMaterialPolicy>): string {
      return serialize(value, resolvePolicy(policy))
    },
    hash(value: unknown, policy?: Partial<HashMaterialPolicy>): CanonicalHash {
      const canonical = serialize(value, resolvePolicy(policy))
      const digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
      return { algorithm: CANONICAL_ALGORITHM, value: digest }
    },
  }
}

/**
 * Scope-keyed HMAC-SHA256 secret digest. The scope is folded into the HMAC key
 * so the same raw secret yields a different digest across compiler scopes /
 * installs, and persisted hashes are never reusable secret fingerprints. The
 * raw secret is never echoed in the result.
 */
export function secretDigest(
  secret: string,
  options?: { scope?: string | undefined }
): SecretDigest {
  const scope = options?.scope
  if (scope !== undefined) {
    const value = createHmac('sha256', `compiler-scoped-secret-digest/v1:${scope}`)
      .update(secret, 'utf8')
      .digest('hex')
    return { algorithm: 'compiler-scoped-secret-digest/v1', value, scope }
  }
  const value = createHmac('sha256', 'hmac-sha256-secret-digest/v1')
    .update(secret, 'utf8')
    .digest('hex')
  return { algorithm: 'hmac-sha256-secret-digest/v1', value, scope: undefined }
}
