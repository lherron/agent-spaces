import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { type AgentRootSearchPath, getAgentRootSearchPathForProject } from 'spaces-config'

export const SHARED_AGENT_ROOT_FILES = [
  'AGENT_MOTD.md',
  'USER.md',
  'conventions.md',
  'context-template.toml',
] as const

export interface AgentProvenance {
  id: string
  root: string
  source: 'project' | 'canonical'
  shadowedRoots: string[]
}

export interface SharedFileOverride {
  file: string
  resolvedPath: string
  shadowedPath: string
}

export interface AgentRootReport {
  searchPath: AgentRootSearchPath
  agents: AgentProvenance[]
  sharedFileOverrides: SharedFileOverride[]
}

export function buildAgentRootReport(
  projectRoot: string | undefined,
  options?: { aspHome?: string | undefined }
): AgentRootReport {
  const searchPath = getAgentRootSearchPathForProject(projectRoot, {
    ...(options?.aspHome ? { aspHome: options.aspHome } : {}),
  })
  const agentById = new Map<string, AgentProvenance>()
  const shadowRootsById = new Map<string, string[]>()

  for (const entry of searchPath.entries) {
    if (!entry.exists) {
      continue
    }

    for (const id of listAgentIds(entry.root)) {
      const existing = agentById.get(id)
      if (!existing) {
        agentById.set(id, {
          id,
          root: join(entry.root, id),
          source: entry.kind,
          shadowedRoots: [],
        })
        continue
      }
      const shadowed = shadowRootsById.get(id) ?? []
      shadowed.push(join(entry.root, id))
      shadowRootsById.set(id, shadowed)
    }
  }

  const agents = [...agentById.values()]
    .map((agent) => ({
      ...agent,
      shadowedRoots: shadowRootsById.get(agent.id) ?? [],
    }))
    .sort((left, right) => left.id.localeCompare(right.id))

  return {
    searchPath,
    agents,
    sharedFileOverrides: findSharedFileOverrides(searchPath),
  }
}

function listAgentIds(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, name, 'agent-profile.toml')))
  } catch {
    return []
  }
}

function findSharedFileOverrides(searchPath: AgentRootSearchPath): SharedFileOverride[] {
  const existingRoots = searchPath.entries.filter((entry) => entry.exists)
  const overrides: SharedFileOverride[] = []

  for (const file of SHARED_AGENT_ROOT_FILES) {
    const resolvedEntry = existingRoots.find((entry) => existsSync(join(entry.root, file)))
    if (!resolvedEntry) {
      continue
    }
    const shadowedEntry = existingRoots
      .slice(existingRoots.indexOf(resolvedEntry) + 1)
      .find((entry) => existsSync(join(entry.root, file)))
    if (!shadowedEntry) {
      continue
    }
    overrides.push({
      file,
      resolvedPath: join(resolvedEntry.root, file),
      shadowedPath: join(shadowedEntry.root, file),
    })
  }

  return overrides
}
