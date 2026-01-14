/**
 * Selector resolution - resolve any selector type to a commit SHA.
 *
 * WHY: This is the core resolution logic that turns abstract
 * selectors (head, dist-tag, semver, git-pin) into concrete commits.
 */

import type { CommitSha, Selector, SpaceId, SpaceRef } from 'spaces-core'
import { SelectorResolutionError, asCommitSha } from 'spaces-core'
import { getHead, getTagCommit } from 'spaces-git'
import { resolveDistTag, versionToGitTag } from './dist-tags.js'
import { type VersionInfo, resolveExactVersion, resolveSemverRange } from './git-tags.js'

/**
 * Resolution result with provenance information.
 */
export interface ResolvedSelector {
  /** The resolved commit SHA */
  commit: CommitSha
  /** The original selector */
  selector: Selector
  /** The git tag that was matched (if any) */
  tag?: string | undefined
  /** The semver version (if resolved via version) */
  semver?: string | undefined
}

/**
 * Options for selector resolution.
 */
export interface SelectorResolveOptions {
  /** Working directory (registry repo root) */
  cwd: string
  /** Git ref for reading dist-tags (default: HEAD) */
  distTagsRef?: string | undefined
}

/**
 * Resolve a selector to a commit SHA.
 */
export async function resolveSelector(
  spaceId: SpaceId,
  selector: Selector,
  options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  switch (selector.kind) {
    case 'dev':
      // Dev selector should be handled in closure.ts before reaching here
      // If we get here, it means the selector was not handled properly
      throw new SelectorResolutionError(
        '@dev selector should be handled in closure computation, not direct selector resolution',
        spaceId,
        'dev'
      )
    case 'head':
      return resolveHeadSelector(spaceId, options)
    case 'dist-tag':
      return resolveDistTagSelector(spaceId, selector.tag, options)
    case 'semver':
      return resolveSemverSelector(spaceId, selector.range, selector.exact, options)
    case 'git-pin':
      return resolveGitPinSelector(spaceId, selector.sha, options)
    default:
      throw new SelectorResolutionError(
        `Unknown selector kind: ${(selector as Selector).kind}`,
        spaceId,
        'unknown'
      )
  }
}

/**
 * Resolve a space reference to a commit SHA.
 */
export async function resolveSpaceRef(
  ref: SpaceRef,
  options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  return resolveSelector(ref.id, ref.selector, options)
}

/**
 * Resolve a HEAD selector - uses current repo HEAD.
 */
async function resolveHeadSelector(
  _spaceId: SpaceId,
  options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  const commit = await getHead({ cwd: options.cwd })
  return {
    commit: asCommitSha(commit),
    selector: { kind: 'head' },
  }
}

/**
 * Resolve a dist-tag selector.
 */
async function resolveDistTagSelector(
  spaceId: SpaceId,
  tagName: string,
  options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  // Look up dist-tag in registry metadata
  const version = await resolveDistTag(spaceId, tagName, {
    cwd: options.cwd,
    ref: options.distTagsRef,
  })

  if (version === null) {
    throw new SelectorResolutionError(
      `Dist-tag '${tagName}' not found for space '${spaceId}'`,
      spaceId,
      tagName
    )
  }

  // Convert version to git tag and resolve to commit
  const gitTag = versionToGitTag(spaceId, version)
  let commit: string
  try {
    commit = await getTagCommit(gitTag, { cwd: options.cwd })
  } catch (_err) {
    throw new SelectorResolutionError(
      `Git tag '${gitTag}' for dist-tag '${tagName}' not found`,
      spaceId,
      tagName
    )
  }

  return {
    commit: asCommitSha(commit),
    selector: { kind: 'dist-tag', tag: tagName },
    tag: gitTag,
    semver: version.startsWith('v') ? version.slice(1) : version,
  }
}

/**
 * Resolve a semver selector (exact or range).
 */
async function resolveSemverSelector(
  spaceId: SpaceId,
  range: string,
  exact: boolean,
  options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  let versionInfo: VersionInfo | null = null

  if (exact) {
    // Exact version match
    versionInfo = await resolveExactVersion(spaceId, range, options)
  } else {
    // Range match - find highest satisfying version
    versionInfo = await resolveSemverRange(spaceId, range, options)
  }

  if (versionInfo === null) {
    throw new SelectorResolutionError(
      exact
        ? `Version '${range}' not found for space '${spaceId}'`
        : `No version matching '${range}' found for space '${spaceId}'`,
      spaceId,
      range
    )
  }

  return {
    commit: versionInfo.commit,
    selector: { kind: 'semver', range, exact },
    tag: versionInfo.tag,
    semver: versionInfo.version,
  }
}

/**
 * Resolve a git-pin selector.
 */
async function resolveGitPinSelector(
  _spaceId: SpaceId,
  sha: CommitSha,
  _options: SelectorResolveOptions
): Promise<ResolvedSelector> {
  // Git pin uses the commit directly - no resolution needed
  // We don't verify the commit exists here; that's done when reading the space
  return {
    commit: sha,
    selector: { kind: 'git-pin', sha },
  }
}

/**
 * Batch resolve multiple space refs.
 */
export async function resolveSpaceRefs(
  refs: SpaceRef[],
  options: SelectorResolveOptions
): Promise<Map<SpaceRef, ResolvedSelector>> {
  const results = new Map<SpaceRef, ResolvedSelector>()

  // Resolve all refs in parallel
  await Promise.all(
    refs.map(async (ref) => {
      const resolved = await resolveSpaceRef(ref, options)
      results.set(ref, resolved)
    })
  )

  return results
}
