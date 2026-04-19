import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'

import type { RuntimeBundleRef } from '../core/types/placement.js'
import type { SpaceRefString } from '../core/types/refs.js'
import { getAgentsRoot, getProjectsRoot } from './asp-config.js'

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
      const projectsRoot = getProjectsRoot(toConfigOptions(options))
      return projectsRoot ? join(projectsRoot, options.projectId) : undefined
    })()

  return {
    ...(agentRoot ? { agentRoot } : {}),
    ...(projectRoot ? { projectRoot } : {}),
    ...((options.cwd ?? projectRoot ?? agentRoot)
      ? { cwd: options.cwd ?? projectRoot ?? agentRoot }
      : {}),
  }
}

export function inferProjectIdFromCwd(options?: InferProjectIdFromCwdOptions): string | undefined {
  const env = options?.env ?? process.env
  const fromEnv = env['ASP_PROJECT']
  if (fromEnv) {
    return fromEnv
  }

  const projectsRoot = getProjectsRoot(
    toConfigOptions({
      aspHome: options?.aspHome,
      env,
    })
  )
  if (!projectsRoot) {
    return undefined
  }

  const cwd = resolve(options?.cwd ?? process.cwd())
  const resolvedRoot = resolve(projectsRoot)
  if (resolve(join(cwd, '..')) !== resolvedRoot) {
    return undefined
  }

  return basename(cwd)
}
