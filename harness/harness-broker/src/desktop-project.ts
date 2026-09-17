import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { ROSTER_SLOT_TOKENS, findProjectMarker } from 'spaces-config'

export const DESKTOP_AGENT_ID = 'stella'
export const DESKTOP_LANE_REF = 'main'

export type WrkqRegistryProject = {
  projectId: string
  root: string
}

export type DesktopProjectResolution =
  | { bound: { projectId: string; projectRoot: string; resolvedBy: string } }
  | {
      pending: true
      reason: 'project_unresolved' | 'project_unregistered' | 'project_ambiguous'
      detail: string
    }

export type DesktopProjectInput = {
  workspaceCwd: string
  env?: Record<string, string | undefined>
  registryProjects?: readonly WrkqRegistryProject[] | undefined
  agentsRoot?: string | undefined
}

function canonicalPath(path: string): string {
  const absolute = resolve(path)
  try {
    return realpathSync(absolute)
  } catch {
    return absolute
  }
}

function isSameOrInside(child: string, parent: string): boolean {
  if (child === parent) return true
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`)
}

function expandHome(root: string, env: Record<string, string | undefined>): string {
  if (root === '~') return env['HOME'] ?? homedir()
  if (root.startsWith('~/')) return resolve(env['HOME'] ?? homedir(), root.slice(2))
  return root
}

async function readRegistryProjects(
  env: Record<string, string | undefined>
): Promise<WrkqRegistryProject[]> {
  const output = await new Promise<string>((resolvePromise, reject) => {
    execFile(
      'wrkq',
      ['projects', '--json'],
      { env: process.env, timeout: 10_000 },
      (error, stdout) => {
        if (error) reject(error)
        else resolvePromise(stdout)
      }
    )
  })
  void env
  const parsed: unknown = JSON.parse(output)
  if (!Array.isArray(parsed)) return []
  const projects: WrkqRegistryProject[] = []
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const projectId =
      typeof record['slug'] === 'string' && record['slug'].length > 0
        ? record['slug']
        : typeof record['path'] === 'string' && record['path'].length > 0
          ? record['path']
          : undefined
    const root = typeof record['root'] === 'string' ? record['root'] : undefined
    if (projectId === undefined || root === undefined || root.trim().length === 0) continue
    projects.push({ projectId, root: root.trim() })
  }
  return projects
}

/**
 * Containing-project resolution for a Desktop thread workspace.
 *
 * Port of the HRC rule in hrc-runtime
 * `packages/hrc-server/src/desktop/project-binding.ts:105-199` (registry
 * deepest wins; an ancestor marker containing the workspace decides; worktree
 * common-dir override is HRC-side and intentionally absent here — ASP never
 * reassigns a worktree to another project, it reports pending instead).
 */
export function resolveDesktopProjectSync(
  workspaceCwd: string,
  projects: readonly WrkqRegistryProject[],
  input: { agentsRoot?: string | undefined }
): DesktopProjectResolution {
  const workspace = canonicalPath(workspaceCwd)
  const candidates = projects
    .filter((project) => {
      if (project.root.trim().length === 0) return false
      const canonicalRoot = canonicalPath(
        expandHome(project.root.trim(), process.env as Record<string, string | undefined>)
      )
      return isSameOrInside(workspace, canonicalRoot)
    })
    .map((project) => ({
      projectId: project.projectId,
      root: canonicalPath(
        expandHome(project.root.trim(), process.env as Record<string, string | undefined>)
      ),
    }))
    .sort((left, right) => right.root.length - left.root.length)
  const deepestRegistry = candidates[0]

  const marker = findProjectMarker(
    workspace,
    input.agentsRoot === undefined ? {} : { agentsRoot: input.agentsRoot }
  )
  const markerRoot = marker === undefined ? undefined : canonicalPath(marker.dir)

  if (deepestRegistry === undefined && markerRoot === undefined) {
    return {
      pending: true,
      reason: 'project_unresolved',
      detail: `no registered project root and no project marker contains ${workspace}`,
    }
  }
  if (deepestRegistry === undefined && markerRoot !== undefined) {
    return {
      pending: true,
      reason: 'project_unregistered',
      detail:
        `workspace boundary ${markerRoot} is not a registered project; ` +
        `run \`wrkq set <project> --root ${markerRoot}\``,
    }
  }
  if (
    deepestRegistry !== undefined &&
    (markerRoot === undefined ||
      markerRoot === deepestRegistry.root ||
      isSameOrInside(markerRoot, deepestRegistry.root))
  ) {
    if (markerRoot !== undefined && markerRoot !== deepestRegistry.root) {
      return {
        pending: true,
        reason: 'project_ambiguous',
        detail:
          `workspace ${workspace} sits under registered project "${deepestRegistry.projectId}" ` +
          `(${deepestRegistry.root}) but its own boundary is ${markerRoot}; ` +
          `register that boundary with \`wrkq set <project> --root ${markerRoot}\` to disambiguate`,
      }
    }
    return {
      bound: {
        projectId: deepestRegistry.projectId,
        projectRoot: deepestRegistry.root,
        resolvedBy: markerRoot === undefined ? 'registry' : 'registry+marker',
      },
    }
  }
  return {
    pending: true,
    reason: 'project_ambiguous',
    detail: `registered root ${deepestRegistry?.root} and workspace boundary ${markerRoot} disagree for ${workspace}`,
  }
}

export async function resolveDesktopProject(
  input: DesktopProjectInput
): Promise<DesktopProjectResolution> {
  const projects =
    input.registryProjects ??
    (await readRegistryProjects(input.env ?? (process.env as Record<string, string | undefined>)))
  return resolveDesktopProjectSync(input.workspaceCwd, projects, { agentsRoot: input.agentsRoot })
}

/**
 * The reservation order `primary-nova` … `primary-cosmos`, then
 * `primary-nova-2` … `primary-cosmos-2`, then `-3`, and so on — ported from
 * hrc-runtime `packages/hrc-server/src/desktop/scope-reservation.ts:44-51`
 * (`desktopSlotTokenSequence`). Bare `primary` is excluded by contract: it is
 * the standing seat's handle and never a desktop conversation's address.
 */
export function* desktopSlotTokenSequence(
  baseTask = 'primary',
  maxRounds = 1_000
): Generator<string, void, void> {
  for (let round = 1; round <= maxRounds; round += 1) {
    const suffix = round === 1 ? '' : `-${round}`
    for (const token of ROSTER_SLOT_TOKENS) {
      yield `${baseTask}-${token}${suffix}`
    }
  }
}

export function desktopScopeRef(agentId: string, projectId: string, slotToken: string): string {
  return `agent:${agentId}:project:${projectId}:task:${slotToken}`
}

export function desktopHostIncarnationId(homeIdentity: string, nativeThreadId: string): string {
  return `host-incarnation:${createHash('sha256')
    .update(homeIdentity, 'utf8')
    .update('\0')
    .update(nativeThreadId.toLowerCase(), 'utf8')
    .digest('hex')}`
}
