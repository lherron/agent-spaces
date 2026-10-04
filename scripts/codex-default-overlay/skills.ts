import { createHash } from 'node:crypto'
import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { join } from 'node:path'

import { SKILL_MARKER_FILE } from './constants'
import type { SkillPlan, SyncManifest } from './types'
import { dedupe, pathExists } from './util'

export function hashString(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export async function loadManifest(manifestPath: string): Promise<SyncManifest | undefined> {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8')) as SyncManifest
  } catch {
    return undefined
  }
}

export interface SkillMarker {
  schemaVersion: 1
  owner: 'agent-spaces'
  kind: 'codex-skill' | 'skill'
  agentId: string
  skillName?: string | undefined
  contentHash?: string | undefined
}

export interface ManagedSkillState {
  marker: SkillMarker
  dirty: boolean
  currentHash?: string | undefined
}

export async function hashSkillDirectory(skillDir: string): Promise<string> {
  const hash = createHash('sha256')

  async function walk(dir: string, relDir: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name
      if (relPath === SKILL_MARKER_FILE) continue

      const path = join(dir, entry.name)
      const stats = await lstat(path)

      if (stats.isDirectory()) {
        hash.update(`dir\u0000${relPath}\u0000`)
        await walk(path, relPath)
        continue
      }

      if (stats.isSymbolicLink()) {
        hash.update(`symlink\u0000${relPath}\u0000${await readlink(path)}\u0000`)
        continue
      }

      if (stats.isFile()) {
        hash.update(`file\u0000${relPath}\u0000`)
        hash.update(await readFile(path))
        hash.update('\u0000')
        continue
      }

      hash.update(`other\u0000${relPath}\u0000${stats.mode}\u0000${stats.size}\u0000`)
    }
  }

  await walk(skillDir, '')
  return `sha256:${hash.digest('hex')}`
}

export function skillMarker(agentId: string, skillName: string, contentHash: string): string {
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      owner: 'agent-spaces',
      agentId,
      kind: 'codex-skill',
      skillName,
      contentHash,
    },
    null,
    2
  )}\n`
}

export async function readManagedSkillState(
  skillDir: string,
  agentId: string
): Promise<ManagedSkillState | undefined> {
  const state = await readAnyManagedSkillState(skillDir)
  return state && state.marker.agentId === agentId ? state : undefined
}

/** Read a managed-skill marker regardless of which agent stamped it. */
export async function readAnyManagedSkillState(
  skillDir: string
): Promise<ManagedSkillState | undefined> {
  const markerPath = join(skillDir, SKILL_MARKER_FILE)
  try {
    const parsed = JSON.parse(await readFile(markerPath, 'utf8')) as Record<string, unknown>
    if (parsed['owner'] !== 'agent-spaces') return undefined
    if (typeof parsed['agentId'] !== 'string' || parsed['agentId'].length === 0) return undefined
    if (parsed['kind'] !== 'codex-skill' && parsed['kind'] !== 'skill') return undefined
    const agentId = parsed['agentId']

    const marker: SkillMarker = {
      schemaVersion: 1,
      owner: 'agent-spaces',
      kind: parsed['kind'],
      agentId,
      ...(typeof parsed['skillName'] === 'string' ? { skillName: parsed['skillName'] } : {}),
      ...(typeof parsed['contentHash'] === 'string' ? { contentHash: parsed['contentHash'] } : {}),
    }

    if (marker.contentHash === undefined) {
      return { marker, dirty: false }
    }

    const currentHash = await hashSkillDirectory(skillDir)
    return { marker, dirty: currentHash !== marker.contentHash, currentHash }
  } catch {
    return undefined
  }
}

async function listSkillDirs(skillsDir: string): Promise<string[]> {
  if (!(await pathExists(skillsDir))) return []
  const entries = await readdir(skillsDir, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}

export async function planSkills(input: {
  sourceSkillsDir: string
  destSkillsDir: string
  agentId: string
  previousManifest?: SyncManifest | undefined
}): Promise<{
  skills: SkillPlan[]
  staleManagedSkills: string[]
  retiredSkills: string[]
  retiredAgents: string[]
  warnings: string[]
}> {
  const warnings: string[] = []
  const sourceNames = await listSkillDirs(input.sourceSkillsDir)
  const previousManaged = new Set(input.previousManifest?.managedSkills ?? [])
  const sourceSet = new Set(sourceNames)
  const staleManagedSkills = [...previousManaged].filter((name) => !sourceSet.has(name)).sort()

  // Managed skills stamped by a previous agent of this Codex home: clean ones in the
  // source are replaced (copy), clean ones not in the source are retired, dirty ones stay.
  const retiredSkills: string[] = []
  const retiredAgents: string[] = []
  for (const name of await listSkillDirs(input.destSkillsDir)) {
    if (sourceSet.has(name)) continue
    const foreign = await readAnyManagedSkillState(join(input.destSkillsDir, name))
    if (!foreign || foreign.marker.agentId === input.agentId) continue
    if (foreign.dirty) {
      warnings.push(
        `skill "${name}" was managed for agent "${foreign.marker.agentId}" and has local edits; leaving it in place`
      )
      continue
    }
    retiredSkills.push(name)
    retiredAgents.push(foreign.marker.agentId)
  }

  const skills: SkillPlan[] = []
  for (const name of sourceNames) {
    const sourcePath = join(input.sourceSkillsDir, name)
    const destPath = join(input.destSkillsDir, name)
    const destExists = await pathExists(destPath)
    if (!destExists) {
      skills.push({ name, sourcePath, destPath, action: 'copy' })
      continue
    }

    const managed = await readAnyManagedSkillState(destPath)
    if (managed && managed.marker.agentId !== input.agentId) {
      if (managed.dirty) {
        const reason = `skill "${name}" was managed for agent "${managed.marker.agentId}" and has local edits; leaving existing skill unchanged`
        warnings.push(reason)
        skills.push({ name, sourcePath, destPath, action: 'skip-dirty-managed', reason })
        continue
      }
      retiredAgents.push(managed.marker.agentId)
      skills.push({
        name,
        sourcePath,
        destPath,
        action: 'copy',
        reason: `replacing skill previously managed for agent "${managed.marker.agentId}"`,
        retiresAgent: managed.marker.agentId,
      })
      continue
    }

    if (managed && !managed.dirty) {
      skills.push({ name, sourcePath, destPath, action: 'update' })
      continue
    }

    if (managed?.dirty) {
      const reason = `skill "${name}" has local edits since the last overlay; leaving existing skill unchanged`
      warnings.push(reason)
      skills.push({ name, sourcePath, destPath, action: 'skip-dirty-managed', reason })
      continue
    }

    const reason = `skill "${name}" already exists in target; leaving existing skill unchanged`
    warnings.push(reason)
    skills.push({ name, sourcePath, destPath, action: 'skip-collision', reason })
  }

  return {
    skills,
    staleManagedSkills,
    retiredSkills: retiredSkills.sort(),
    retiredAgents: dedupe(retiredAgents).sort(),
    warnings,
  }
}

export async function listForeignManifests(codexHome: string, agentId: string): Promise<string[]> {
  const dir = join(codexHome, '.asp-agent-sync')
  if (!(await pathExists(dir))) return []
  const names = await readdir(dir)
  const foreign: string[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const manifest = await loadManifest(join(dir, name))
    if (!manifest || manifest.owner !== 'agent-spaces') continue
    if (manifest.agentId === agentId) continue
    foreign.push(name.slice(0, -'.json'.length))
  }
  return foreign.sort()
}
