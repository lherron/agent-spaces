import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { RuntimeBundleRef } from '../core/types/placement.js'
import type { SpaceRefString } from '../core/types/refs.js'
import { getAgentRootSearchPathForProject, getAgentsRoot } from './asp-config.js'

export interface RuntimeBundleRefOptions {
  agentName?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  compose?: string[] | undefined
}

export interface ResolveAgentPlacementPathsOptions {
  agentId: string
  projectId?: string | undefined
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}

export interface ResolvedAgentPlacementPaths {
  agentRoot?: string | undefined
  projectRoot?: string | undefined
  cwd?: string | undefined
  searchedAgentRoots?: string[] | undefined
  warnings?: string[] | undefined
}

export interface InferProjectIdFromCwdOptions {
  cwd?: string | undefined
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}

export interface ProjectMarker {
  dir: string
  id: string
}

/** Filename that marks a directory as an ASP project root. */
export const PROJECT_MARKER_FILENAME = 'asp-targets.toml'

function expandHome(p: string, env: Record<string, string | undefined> = process.env): string {
  const home = env['HOME'] ?? homedir()
  if (p === '~') return home
  if (p.startsWith('~/')) return join(home, p.slice(2))
  return p
}

function toConfigOptions(options?: {
  aspHome?: string | undefined
  env?: Record<string, string | undefined> | undefined
}): { aspHome?: string; env?: Record<string, string | undefined> } {
  return {
    ...(options?.aspHome ? { aspHome: options.aspHome } : {}),
    ...(options?.env ? { env: options.env } : {}),
  }
}

/**
 * Walk up from `startDir` looking for an `asp-targets.toml`, or infer an
 * implicit marker from the containing git repository.
 *
 * Rules:
 * - Explicit marker wins: the first `asp-targets.toml` on the walk-up
 *   (bounded by the git repo root) defines the project.
 * - Implicit git fallback: if no marker is found and `startDir` lies
 *   inside a git repo, the repo root is treated as the project root
 *   with id = basename(repoRoot). Each git repo is its own project.
 * - Agent home guard: `agentsRoot` (if provided) is never crossed —
 *   dirs at or inside it are not considered project roots.
 * - No git, no marker → undefined. Caller decides (prompt, error, or
 *   silent fallback to agentRoot).
 */
export function findProjectMarker(
  startDir: string,
  options?: {
    agentsRoot?: string | undefined
    agentRoots?: string[] | undefined
    projectRoot?: string | undefined
  }
): ProjectMarker | undefined {
  let dir = resolve(startDir)
  const agentRoots = [
    ...(options?.agentRoots ?? []),
    ...(options?.agentsRoot ? [options.agentsRoot] : []),
  ].map((root) => resolve(root))
  const allowedProjectRoot = options?.projectRoot ? resolve(options.projectRoot) : undefined
  const gitRoot = findGitRoot(dir)

  const boundaryFor = (p: string): string | undefined =>
    agentRoots.find((root) => isSameOrInside(p, root))

  const canCrossBoundary = (root: string): boolean =>
    allowedProjectRoot !== undefined && isSameOrInside(root, allowedProjectRoot)

  while (true) {
    const boundary = boundaryFor(dir)
    if (boundary !== undefined && !canCrossBoundary(boundary)) {
      return undefined
    }
    if (boundary === undefined && existsSync(join(dir, PROJECT_MARKER_FILENAME))) {
      return { dir, id: basename(dir) }
    }
    if (gitRoot && dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }

  // No explicit marker. Fall back to the containing git repo root, if any.
  const gitBoundary = gitRoot ? boundaryFor(gitRoot) : undefined
  if (gitRoot && (gitBoundary === undefined || canCrossBoundary(gitBoundary))) {
    return { dir: gitRoot, id: basename(gitRoot) }
  }
  return undefined
}

function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Walk up from `startDir` looking for a `.git` directory or file (git
 * worktrees use a file). Returns the containing repo root, or undefined.
 */
function findGitRoot(startDir: string): string | undefined {
  let dir = resolve(startDir)
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

export function buildRuntimeBundleRef(options: RuntimeBundleRefOptions): RuntimeBundleRef {
  // 1. compose (explicit space list)
  if (options.compose && options.compose.length > 0) {
    return { kind: 'compose', compose: options.compose as SpaceRefString[] }
  }

  // 2–4. agentName paths
  if (options.agentName) {
    if (!options.agentRoot) {
      throw new Error(
        'buildRuntimeBundleRef: agentRoot is required when agentName is provided. Use resolveAgentPlacementPaths to derive it from agentId + ASP_AGENTS_ROOT.'
      )
    }
    const profilePath = join(options.agentRoot, 'agent-profile.toml')
    if (!existsSync(profilePath)) {
      throw new Error(
        `buildRuntimeBundleRef: agent-profile.toml not found at ${profilePath} — agent install incomplete`
      )
    }
    return {
      kind: 'agent-project',
      agentName: options.agentName,
      ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
    }
  }

  // 5. No identifying selector
  throw new Error(
    'buildRuntimeBundleRef: no identifying selector provided; supply agentName+agentRoot or compose'
  )
}

export function resolveAgentPlacementPaths(
  options: ResolveAgentPlacementPathsOptions
): ResolvedAgentPlacementPaths {
  const projectRoot =
    options.projectRoot ??
    (() => {
      if (!options.projectId) {
        return undefined
      }
      const env = options.env ?? process.env
      const override = env['ASP_PROJECT_ROOT_OVERRIDE']
      if (override) {
        return expandHome(override, env)
      }
      // Without an override, fall back to the marker walk-up from cwd.
      // This lets callers supply just a projectId and still land on a sensible
      // projectRoot as long as a marker exists somewhere above cwd.
      const startDir = options.cwd ?? process.cwd()
      const agentsRoot = getAgentsRoot(toConfigOptions(options))
      const marker = findProjectMarker(startDir, { agentsRoot })
      if (marker && marker.id === options.projectId) {
        return marker.dir
      }
      return undefined
    })()

  const searchPath = getAgentRootSearchPathForProject(projectRoot, toConfigOptions(options))
  const searchedAgentRoots = searchPath.roots.map((root) => join(root, options.agentId))
  const agentRoot =
    options.agentRoot ??
    searchedAgentRoots.find((root) => existsSync(join(root, 'agent-profile.toml')))
  const warnings = searchPath.warnings.map((warning) => warning.message)

  return {
    ...(agentRoot ? { agentRoot } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...(!agentRoot && searchedAgentRoots.length > 0 ? { searchedAgentRoots } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...((options.cwd ?? projectRoot ?? agentRoot)
      ? { cwd: options.cwd ?? projectRoot ?? agentRoot }
      : {}),
  }
}

/**
 * Infer a projectId from the current working directory.
 *
 * Resolution: `asp-targets.toml` (or implicit git-repo root) found by walking
 * up from cwd — id = basename(markerDir).
 *
 * This intentionally does NOT consult `ASP_PROJECT`: the function name promises
 * cwd inference, and conflating it with the env var makes `ASP_PROJECT ??
 * inferProjectIdFromCwd()` dead code and defeats any cwd-vs-env comparison.
 * Callers that want env precedence compose it explicitly, e.g.
 * `explicitOption ?? env.ASP_PROJECT ?? inferProjectIdFromCwd()`.
 *
 * Returns undefined if no marker/repo is found. Callers decide whether to
 * prompt, error, or silently fall back.
 */
export function inferProjectIdFromCwd(options?: InferProjectIdFromCwdOptions): string | undefined {
  const env = options?.env ?? process.env
  const agentsRoot = getAgentsRoot(toConfigOptions({ aspHome: options?.aspHome, env }))
  const marker = findProjectMarker(options?.cwd ?? process.cwd(), { agentsRoot })
  return marker?.id
}
