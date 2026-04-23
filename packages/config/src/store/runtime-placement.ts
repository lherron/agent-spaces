import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'

import type { RuntimeBundleRef } from '../core/types/placement.js'
import type { SpaceRefString } from '../core/types/refs.js'
import { getAgentsRoot } from './asp-config.js'

export interface RuntimeBundleRefOptions {
  agentName?: string | undefined
  agentRoot?: string | undefined
  bundle?: string | undefined
  agentTarget?: string | undefined
  projectTarget?: string | undefined
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

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
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
  options?: { agentsRoot?: string | undefined }
): ProjectMarker | undefined {
  let dir = resolve(startDir)
  const agentsRoot = options?.agentsRoot ? resolve(options.agentsRoot) : undefined
  const gitRoot = findGitRoot(dir)

  const insideAgentsRoot = (p: string): boolean =>
    agentsRoot !== undefined && (p === agentsRoot || p.startsWith(`${agentsRoot}/`))

  while (true) {
    if (insideAgentsRoot(dir)) return undefined
    if (existsSync(join(dir, PROJECT_MARKER_FILENAME))) {
      return { dir, id: basename(dir) }
    }
    if (gitRoot && dir === gitRoot) break
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }

  // No explicit marker. Fall back to the containing git repo root, if any.
  if (gitRoot && !insideAgentsRoot(gitRoot)) {
    return { dir: gitRoot, id: basename(gitRoot) }
  }
  return undefined
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
  if (options.agentTarget) {
    return { kind: 'agent-target', target: options.agentTarget }
  }
  if (options.projectTarget) {
    if (!options.projectRoot) {
      throw new Error('--project-root is required with --project-target')
    }
    return {
      kind: 'project-target',
      projectRoot: options.projectRoot,
      target: options.projectTarget,
    }
  }
  if (options.compose && options.compose.length > 0) {
    return { kind: 'compose', compose: options.compose as SpaceRefString[] }
  }
  if (options.agentName && options.agentRoot) {
    const profilePath = join(options.agentRoot, 'agent-profile.toml')
    if (existsSync(profilePath)) {
      return {
        kind: 'agent-project',
        agentName: options.agentName,
        ...(options.projectRoot ? { projectRoot: options.projectRoot } : {}),
      }
    }
  }
  return { kind: 'agent-default' }
}

export function resolveAgentPlacementPaths(
  options: ResolveAgentPlacementPathsOptions
): ResolvedAgentPlacementPaths {
  const agentRoot =
    options.agentRoot ??
    (() => {
      const agentsRoot = getAgentsRoot(toConfigOptions(options))
      return agentsRoot ? join(agentsRoot, options.agentId) : undefined
    })()

  const projectRoot =
    options.projectRoot ??
    (() => {
      if (!options.projectId) {
        return undefined
      }
      const env = options.env ?? process.env
      const override = env['ASP_PROJECT_ROOT_OVERRIDE']
      if (override) {
        return expandHome(override)
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

  return {
    ...(agentRoot ? { agentRoot } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...((options.cwd ?? projectRoot ?? agentRoot)
      ? { cwd: options.cwd ?? projectRoot ?? agentRoot }
      : {}),
  }
}

/**
 * Infer a projectId from the current environment.
 *
 * Precedence:
 *   1. `ASP_PROJECT` env var (explicit override from caller or parent process).
 *   2. `asp-targets.toml` found by walking up from cwd — id = basename(markerDir).
 *
 * Returns undefined if neither signal is present. Callers are expected to
 * decide whether to prompt, error, or silently fall back.
 */
export function inferProjectIdFromCwd(options?: InferProjectIdFromCwdOptions): string | undefined {
  const env = options?.env ?? process.env
  const fromEnv = env['ASP_PROJECT']
  if (fromEnv) {
    return fromEnv
  }

  const agentsRoot = getAgentsRoot(toConfigOptions({ aspHome: options?.aspHome, env }))
  const marker = findProjectMarker(options?.cwd ?? process.cwd(), { agentsRoot })
  return marker?.id
}
