/**
 * Space reference parsing utilities.
 *
 * WHY: Re-exports core parsing functions with additional context
 * for resolver-specific operations.
 */

import {
  type CommitSha,
  type Selector,
  type SpaceId,
  type SpaceKey,
  type SpaceRef,
  type SpaceRefString,
  asCommitSha,
  asSpaceId,
  asSpaceKey,
  parseSpaceRef as coreParseSpaceRef,
  formatSpaceRef,
  isSpaceRefString,
  parseSelector,
} from 'spaces-core'

// Re-export core parsing functions
export { parseSpaceRef as parseSpaceRefCore } from 'spaces-core'
export { parseSelector, formatSpaceRef, isSpaceRefString }

// Re-export type constructors
export { asSpaceId, asCommitSha, asSpaceKey }

// Re-export types
export type { SpaceRef, SpaceRefString, Selector, SpaceId, CommitSha, SpaceKey }

/**
 * Parse a space reference string with validation.
 * Wraps the core function to provide resolver-specific context.
 */
export function parseSpaceRef(refString: string): SpaceRef {
  return coreParseSpaceRef(refString)
}

/**
 * Build a space key from id and commit.
 * Uses the first 12 chars of the commit for shorter keys.
 */
export function buildSpaceKey(id: SpaceId, commit: CommitSha): SpaceKey {
  // asSpaceKey takes (SpaceId, CommitSha) and returns SpaceKey
  const shortCommit = asCommitSha(commit.slice(0, 12))
  return asSpaceKey(id, shortCommit)
}

/**
 * Parse a space key back into id and commit.
 */
export function parseSpaceKey(key: SpaceKey): { id: SpaceId; commit: string } {
  const atIdx = key.lastIndexOf('@')
  if (atIdx === -1) {
    throw new Error(`Invalid space key: ${key}`)
  }
  const id = key.slice(0, atIdx)
  const commit = key.slice(atIdx + 1)
  return { id: asSpaceId(id), commit }
}

/**
 * Extract all space refs from an array of ref strings.
 */
export function parseAllRefs(refStrings: SpaceRefString[]): SpaceRef[] {
  return refStrings.map((s) => parseSpaceRef(s))
}
