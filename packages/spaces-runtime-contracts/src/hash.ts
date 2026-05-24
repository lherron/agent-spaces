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
