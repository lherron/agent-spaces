import { existsSync } from 'node:fs'
import { readFile, readdir, realpath } from 'node:fs/promises'
import { join } from 'node:path'

import { validateAgentRoot } from 'spaces-config'

export interface InventoryExclusion {
  agentId: string
  expectedDiagnostic: string
}

export interface AgentInventory {
  agentsRoot: string
  valid: { agentId: string; agentRoot: string }[]
  excluded: { agentId: string; diagnostic: string }[]
}

function codePointCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function expectedDiagnostic(exclusion: InventoryExclusion, agentRoot: string): string {
  return exclusion.expectedDiagnostic.replace('{agentRoot}', agentRoot)
}

/** Inventory valid runtime agent roots and fail closed on roster drift. */
export async function inventoryAgents(input: {
  agentsRoot: string
  exclusions: readonly InventoryExclusion[]
}): Promise<AgentInventory> {
  const agentsRoot = await realpath(input.agentsRoot)
  const exclusions = new Map(input.exclusions.map((entry) => [entry.agentId, entry]))
  const candidates = (await readdir(agentsRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && existsSync(join(agentsRoot, entry.name, 'agent-profile.toml'))
    )
    .map((entry) => entry.name)
    .sort(codePointCompare)
  const seenExclusions = new Set<string>()
  const valid: AgentInventory['valid'] = []
  const excluded: AgentInventory['excluded'] = []
  for (const agentId of candidates) {
    const agentRoot = join(agentsRoot, agentId)
    const exclusion = exclusions.get(agentId)
    try {
      validateAgentRoot(agentRoot)
      if (exclusion !== undefined) throw new Error(`Excluded agent is now valid: ${agentId}`)
      valid.push({ agentId, agentRoot })
    } catch (error) {
      const diagnostic = error instanceof Error ? error.message : String(error)
      if (exclusion === undefined)
        throw new Error(`Invalid agent candidate ${agentId}: ${diagnostic}`)
      const expected = expectedDiagnostic(exclusion, agentRoot)
      if (diagnostic !== expected)
        throw new Error(
          `Exclusion diagnostic changed for ${agentId}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(diagnostic)}`
        )
      seenExclusions.add(agentId)
      excluded.push({ agentId, diagnostic })
    }
  }
  for (const exclusion of input.exclusions) {
    if (!seenExclusions.has(exclusion.agentId))
      throw new Error(`Exclusion names no invalid candidate: ${exclusion.agentId}`)
  }
  return { agentsRoot, valid, excluded }
}

export async function readInventoryExclusions(path: string): Promise<InventoryExclusion[]> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (!Array.isArray(value)) throw new Error(`Inventory exclusions must be an array: ${path}`)
  return value.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as Record<string, unknown>)['agentId'] !== 'string' ||
      typeof (entry as Record<string, unknown>)['expectedDiagnostic'] !== 'string'
    )
      throw new Error(`Invalid inventory exclusion in ${path}`)
    return entry as InventoryExclusion
  })
}
