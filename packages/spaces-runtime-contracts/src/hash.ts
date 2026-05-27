export type HashAlgorithm = 'sha256-canonical-json/v1'
export type RuntimeContractHashProjection = 'runtime-contract-semantic/v2'

export type CanonicalHash = {
  algorithm: HashAlgorithm
  value: string
}

export type HashMaterialPolicy = {
  hashProjection: RuntimeContractHashProjection
  omitPaths: string[]
  timestampMode: 'omit-ephemeral' | 'include-semantic'
}

export interface CanonicalHasher {
  canonicalize(value: unknown, policy?: Partial<HashMaterialPolicy>): string
  hash(value: unknown, policy?: Partial<HashMaterialPolicy>): CanonicalHash
}

// ---------------------------------------------------------------------------
// Implementation (sha256-canonical-json/v1)
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto'
import type { JsonValue } from './primitives'

const CANONICAL_ALGORITHM: HashAlgorithm = 'sha256-canonical-json/v1'
export const DEFAULT_HASH_PROJECTION: RuntimeContractHashProjection = 'runtime-contract-semantic/v2'

const DEFAULT_POLICY: HashMaterialPolicy = {
  hashProjection: DEFAULT_HASH_PROJECTION,
  omitPaths: [],
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
  const omitPaths = policy?.omitPaths ?? DEFAULT_POLICY.omitPaths
  for (const omitPath of omitPaths) {
    if (omitsLockedEnv(omitPath)) {
      throw new Error('Hash omitPaths must not omit process.lockedEnv')
    }
  }
  return {
    hashProjection: policy?.hashProjection ?? DEFAULT_POLICY.hashProjection,
    omitPaths,
    timestampMode: policy?.timestampMode ?? DEFAULT_POLICY.timestampMode,
  }
}

function serializeNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new RangeError(`canonical hash forbids non-finite number: ${String(value)}`)
  }
  return JSON.stringify(value)
}

function serialize(value: unknown, policy: HashMaterialPolicy, pointer = ''): string {
  if (policy.omitPaths.includes(pointer)) return ''
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

  if (Array.isArray(value)) {
    const items = value.map((item, index) =>
      item === undefined ? 'null' : serialize(item, policy, `${pointer}/${index}`)
    )
    return `[${items.join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const parts: string[] = []
  for (const key of keys) {
    const childPointer = `${pointer}/${escapeJsonPointerToken(key)}`
    if (policy.omitPaths.includes(childPointer)) continue
    if (policy.timestampMode === 'omit-ephemeral' && isEphemeralTimestampField(key)) {
      continue
    }
    const child = record[key]
    if (child === undefined) continue // omit undefined; null is preserved
    parts.push(`${JSON.stringify(key)}:${serialize(child, policy, childPointer)}`)
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

function escapeJsonPointerToken(token: string): string {
  return token.replaceAll('~', '~0').replaceAll('/', '~1')
}

function omitsLockedEnv(omitPath: string): boolean {
  return (
    omitPath === '/process/lockedEnv' ||
    omitPath.endsWith('/process/lockedEnv') ||
    omitPath.includes('/process/lockedEnv/')
  )
}

export type RuntimeContractProjectionKind = 'plan' | 'profile' | 'spec' | 'start-request'

export type RuntimeContractProjection =
  | {
      hashProjection: RuntimeContractHashProjection
      planHash: string
      value: JsonValue
    }
  | {
      hashProjection: RuntimeContractHashProjection
      profileHash: string
      value: JsonValue
    }
  | {
      hashProjection: RuntimeContractHashProjection
      specHash: string
      value: JsonValue
    }
  | {
      hashProjection: RuntimeContractHashProjection
      startRequestHash: string
      value: JsonValue
    }

export function project(
  source: unknown,
  kind: RuntimeContractProjectionKind
): RuntimeContractProjection {
  const policy = resolvePolicy({
    hashProjection: DEFAULT_HASH_PROJECTION,
    omitPaths: projectionOmitPaths(kind),
    timestampMode: 'omit-ephemeral',
  })
  const canonical = serialize(source, policy)
  const value = JSON.parse(canonical) as JsonValue
  const hashValue = createHash('sha256').update(canonical, 'utf8').digest('hex')
  const base = {
    hashProjection: policy.hashProjection,
    value,
  }
  switch (kind) {
    case 'plan':
      return { ...base, planHash: hashValue }
    case 'profile':
      return { ...base, profileHash: hashValue }
    case 'spec':
      return { ...base, specHash: hashValue }
    case 'start-request':
      return { ...base, startRequestHash: hashValue }
  }
}

function projectionOmitPaths(kind: RuntimeContractProjectionKind): string[] {
  switch (kind) {
    case 'plan':
      return ['/planHash']
    case 'profile':
      return ['/profileHash', '/compatibilityHash']
    case 'spec':
    case 'start-request':
      return []
  }
}
