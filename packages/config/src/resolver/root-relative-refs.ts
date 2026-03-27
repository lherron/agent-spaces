/**
 * Root-relative reference resolution.
 *
 * Supports:
 * - agent-root:///<relative-path>
 * - project-root:///<relative-path>
 *
 * Rules (from AGENT_SPACES_PLAN.md section 6):
 * - resolve against declared absolute roots
 * - normalize before access
 * - reject ".." escapes
 * - reject symlink or alias escapes outside the declared root
 */

import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, join, normalize, relative } from 'node:path'

/** Root-relative ref scheme discriminator */
export type RootRefScheme = 'agent-root' | 'project-root'

/** Parsed root-relative ref */
export interface ParsedRootRef {
  scheme: RootRefScheme
  relativePath: string
}

const ROOT_REF_PATTERN = /^(agent-root|project-root):\/\/\/(.+)$/

/**
 * Check if a string is a root-relative ref.
 */
export function isRootRef(ref: string): boolean {
  return ROOT_REF_PATTERN.test(ref)
}

/**
 * Parse a root-relative ref string.
 * Returns undefined if the string is not a valid root-relative ref.
 */
export function parseRootRef(ref: string): ParsedRootRef | undefined {
  const match = ROOT_REF_PATTERN.exec(ref)
  if (!match?.[1] || !match[2]) return undefined
  return {
    scheme: match[1] as RootRefScheme,
    relativePath: match[2],
  }
}

/**
 * Options for resolving root-relative refs.
 */
export interface RootRefResolveOptions {
  agentRoot?: string | undefined
  projectRoot?: string | undefined
}

/**
 * Resolve a root-relative ref to an absolute filesystem path.
 *
 * Validates:
 * - The ref uses a known scheme (agent-root or project-root)
 * - The appropriate root is provided
 * - The relative path does not contain ".." escapes
 * - The resolved path stays within the root (including after symlink resolution)
 *
 * Throws on validation failure.
 */
export function resolveRootRelativeRef(ref: string, options: RootRefResolveOptions): string {
  const parsed = parseRootRef(ref)
  if (!parsed) {
    throw new Error(`Unknown or unsupported root-relative scheme in ref: "${ref}"`)
  }

  const root = parsed.scheme === 'agent-root' ? options.agentRoot : options.projectRoot

  if (!root) {
    throw new Error(
      parsed.scheme === 'agent-root'
        ? `agentRoot is required to resolve ref: "${ref}"`
        : `projectRoot is required to resolve ref: "${ref}"`
    )
  }

  if (!isAbsolute(root)) {
    throw new Error(`Root must be an absolute path, got: "${root}"`)
  }

  return resolveContainedPath(root, parsed.relativePath)
}

/**
 * Resolve a relative path against a root, ensuring containment.
 *
 * Steps:
 * 1. Reject if relative path is absolute
 * 2. Normalize the path
 * 3. Reject if normalized path escapes via ".."
 * 4. Join with root
 * 5. If the path exists, verify realpath stays within root (symlink check)
 */
export function resolveContainedPath(root: string, relativePath: string): string {
  // Reject absolute paths
  if (isAbsolute(relativePath)) {
    throw new Error(`Relative path must not be absolute: "${relativePath}"`)
  }

  // Normalize to collapse redundant separators and ./
  const normalized = normalize(relativePath)

  // Reject ".." escapes in the normalized path
  if (normalized.startsWith('..') || normalized.includes('/..') || normalized.includes('\\..')) {
    throw new Error(`Path "${relativePath}" escapes the root via ".." traversal`)
  }

  const candidate = join(root, normalized)

  // Verify the joined path is still within root (handles edge cases)
  const rel = relative(root, candidate)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Path "${relativePath}" escapes the root "${root}"`)
  }

  // If the path exists on disk, verify realpath doesn't escape via symlinks
  if (existsSync(candidate)) {
    const realRoot = realpathSync(root)
    const realCandidate = realpathSync(candidate)
    const realRel = relative(realRoot, realCandidate)

    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      throw new Error(
        `Path "${relativePath}" escapes the root "${root}" via symlink (resolves to "${realCandidate}")`
      )
    }
  }

  return candidate
}
