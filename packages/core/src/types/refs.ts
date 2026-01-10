/**
 * Space reference types for Agent Spaces v2
 *
 * A Space ref is: `space:<id>@<selector>`
 *
 * Selector forms:
 * - Dist-tag: `stable`, `latest`, `beta`
 * - Semver: `1.2.3`, `^1.2.0`, `~1.2.3`
 * - Direct pin: `git:<sha>`
 */

/** Space identifier (kebab-case, 1-64 chars) */
export type SpaceId = string & { readonly __brand: 'SpaceId' }

/** Git commit SHA (7-64 hex chars) */
export type CommitSha = string & { readonly __brand: 'CommitSha' }

/** SHA256 integrity hash in format `sha256:<64-hex-chars>` */
export type Sha256Integrity = `sha256:${string}`

/** Space key format: `<id>@<commit>` - uniquely identifies a space version */
export type SpaceKey = `${string}@${string}`

/** Selector type discriminator */
export type SelectorKind = 'dist-tag' | 'semver' | 'git-pin'

/** Known dist-tag names */
export type DistTagName = 'stable' | 'latest' | 'beta' | (string & {})

/** Parsed selector for a space reference */
export type Selector =
  | { kind: 'dist-tag'; tag: DistTagName }
  | { kind: 'semver'; range: string; exact: boolean }
  | { kind: 'git-pin'; sha: CommitSha }

/** Parsed space reference */
export interface SpaceRef {
  /** Space identifier */
  id: SpaceId
  /** Original selector string (e.g., "stable", "^1.0.0", "git:abc123") */
  selectorString: string
  /** Parsed selector */
  selector: Selector
}

/** Raw space reference string format: `space:<id>@<selector>` */
export type SpaceRefString = `space:${string}@${string}`

// ============================================================================
// Type guards and constructors
// ============================================================================

const SPACE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{7,64}$/
const SHA256_INTEGRITY_PATTERN = /^sha256:[0-9a-f]{64}$/
const SPACE_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*@[0-9a-f]{7,64}$/
const SPACE_REF_PATTERN = /^space:([a-z0-9]+(?:-[a-z0-9]+)*)@(.+)$/
const SEMVER_RANGE_PATTERN = /^[\^~]?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const SEMVER_EXACT_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const GIT_PIN_PATTERN = /^git:([0-9a-f]{7,64})$/
const KNOWN_DIST_TAGS = new Set(['stable', 'latest', 'beta'])

export function isSpaceId(value: string): value is SpaceId {
  return SPACE_ID_PATTERN.test(value) && value.length >= 1 && value.length <= 64
}

export function asSpaceId(value: string): SpaceId {
  if (!isSpaceId(value)) {
    throw new Error(`Invalid space ID: "${value}" (must be kebab-case, 1-64 chars)`)
  }
  return value
}

export function isCommitSha(value: string): value is CommitSha {
  return COMMIT_SHA_PATTERN.test(value)
}

export function asCommitSha(value: string): CommitSha {
  if (!isCommitSha(value)) {
    throw new Error(`Invalid commit SHA: "${value}" (must be 7-64 hex chars)`)
  }
  return value
}

export function isSha256Integrity(value: string): value is Sha256Integrity {
  return SHA256_INTEGRITY_PATTERN.test(value)
}

export function asSha256Integrity(value: string): Sha256Integrity {
  if (!isSha256Integrity(value)) {
    throw new Error(`Invalid SHA256 integrity: "${value}"`)
  }
  return value as Sha256Integrity
}

export function isSpaceKey(value: string): value is SpaceKey {
  return SPACE_KEY_PATTERN.test(value)
}

export function asSpaceKey(id: SpaceId, commit: CommitSha): SpaceKey {
  return `${id}@${commit}` as SpaceKey
}

export function parseSpaceKey(key: SpaceKey): { id: SpaceId; commit: CommitSha } {
  const atIndex = key.lastIndexOf('@')
  if (atIndex === -1) {
    throw new Error(`Invalid space key: "${key}"`)
  }
  return {
    id: key.slice(0, atIndex) as SpaceId,
    commit: key.slice(atIndex + 1) as CommitSha,
  }
}

export function isSpaceRefString(value: string): value is SpaceRefString {
  return SPACE_REF_PATTERN.test(value)
}

export function parseSelector(selectorString: string): Selector {
  // Check for git pin first
  const gitMatch = GIT_PIN_PATTERN.exec(selectorString)
  if (gitMatch?.[1]) {
    return { kind: 'git-pin', sha: gitMatch[1] as CommitSha }
  }

  // Check for semver range (with ^ or ~)
  if (selectorString.startsWith('^') || selectorString.startsWith('~')) {
    if (SEMVER_RANGE_PATTERN.test(selectorString)) {
      return { kind: 'semver', range: selectorString, exact: false }
    }
  }

  // Check for exact semver
  if (SEMVER_EXACT_PATTERN.test(selectorString)) {
    return { kind: 'semver', range: selectorString, exact: true }
  }

  // Treat as dist-tag (known or custom)
  return { kind: 'dist-tag', tag: selectorString as DistTagName }
}

export function parseSpaceRef(refString: string): SpaceRef {
  const match = SPACE_REF_PATTERN.exec(refString)
  if (!match?.[1] || !match[2]) {
    throw new Error(`Invalid space ref: "${refString}" (must be space:<id>@<selector>)`)
  }

  const id = asSpaceId(match[1])
  const selectorString = match[2]
  const selector = parseSelector(selectorString)

  return { id, selectorString, selector }
}

export function formatSpaceRef(ref: SpaceRef): SpaceRefString {
  return `space:${ref.id}@${ref.selectorString}` as SpaceRefString
}

export function isKnownDistTag(tag: string): tag is 'stable' | 'latest' | 'beta' {
  return KNOWN_DIST_TAGS.has(tag)
}
