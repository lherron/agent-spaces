/**
 * Space-entry classification and content-directory resolution.
 *
 * WHY: The "what kind of space is this?" determination (dev / project / agent /
 * registry) and the downstream "where does this space's content live?" selection
 * were duplicated verbatim across install/build/materialize orchestration. These
 * helpers centralize that logic so the marker comparisons and path selection live
 * in exactly one place.
 */

import { join } from 'node:path'

import type { LockSpaceEntry } from '../core/index.js'
import { AGENT_COMMIT_MARKER, PROJECT_COMMIT_MARKER } from '../core/index.js'
import type { PathResolver } from '../store/index.js'
import { DEV_COMMIT_MARKER } from './closure.js'
import { DEV_INTEGRITY } from './integrity.js'

/** The provenance kind of a locked space entry. */
export type SpaceEntryKind = 'dev' | 'project' | 'agent' | 'registry'

/**
 * Short commit prefix length used to build `<id>@<commit-prefix>` space keys.
 */
export const COMMIT_KEY_PREFIX_LEN = 12

/**
 * Classify a locked space entry by provenance.
 *
 * Order matters: dev/project/agent are filesystem-backed (no snapshot), while
 * everything else is content-addressed in the store ("registry").
 */
export function classifySpaceEntry(entry: LockSpaceEntry): SpaceEntryKind {
  if (entry.commit === DEV_COMMIT_MARKER || entry.integrity === DEV_INTEGRITY) {
    return 'dev'
  }
  if (entry.commit === PROJECT_COMMIT_MARKER || entry.projectSpace) {
    return 'project'
  }
  if (entry.commit === AGENT_COMMIT_MARKER || entry.agentSpace) {
    return 'agent'
  }
  return 'registry'
}

/** Filesystem roots used to resolve a space's content directory. */
export interface SpaceContentRoots {
  /** Agent root (spaces/ live under this) — required for agent spaces. */
  agentPath?: string | undefined
  /** Project root (spaces/ live under this). */
  projectPath: string
  /** Registry repo path (spaces/ live under this) — used for @dev spaces. */
  registryPath: string
  /** Path resolver for the content-addressed store. */
  paths: PathResolver
}

/**
 * Resolve the directory that holds a space's content for the given kind.
 *
 * - agent spaces: read from the agent's `spaces/` directory (falls back to the
 *   content store when no agent path is available)
 * - project spaces: read from the project's `spaces/` directory
 * - @dev spaces: read from the registry's `spaces/` directory
 * - registry spaces: read from the content-addressed store
 */
export function resolveSpaceContentDir(
  kind: SpaceEntryKind,
  entry: LockSpaceEntry,
  roots: SpaceContentRoots
): string {
  if (kind === 'agent' && roots.agentPath) {
    return join(roots.agentPath, 'spaces', entry.id)
  }
  if (kind === 'project') {
    return join(roots.projectPath, 'spaces', entry.id)
  }
  if (kind === 'dev') {
    return join(roots.registryPath, 'spaces', entry.id)
  }
  return roots.paths.snapshot(entry.integrity)
}
