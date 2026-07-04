/**
 * Discover hygiene units from a filesystem target.
 *
 * WHY: The linter runs over real trees: a single skill, a single prompt file, one
 * agent root, or a whole var/agents tree. This module normalizes any of those into
 * a HygieneContext (units + per-agent-root reference facts for the dead-layer rule).
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import { parseSkillFrontmatter, promptRegime } from './parse.js'
import type { AgentRootInfo, HygieneContext, HygieneUnit } from './types.js'

/**
 * Agent-root instruction/identity files the linter assesses when scanning an agent
 * root. AGENTS.md / CLAUDE.md / GEMINI.md are the harness-convention instruction
 * files that agents assume load but may be dead under the bundle-home model (XL0).
 */
const KNOWN_PROMPT_FILES = [
  'SOUL.md',
  'AGENTS.md',
  'CLAUDE.md',
  'GEMINI.md',
  'conventions.md',
  'USER.md',
] as const

/** Shared/top-level prompt files linted when a var/agents tree is scanned. */
const SHARED_PROMPT_FILES = ['AGENT_MOTD.md', 'conventions.md', 'USER.md'] as const

/**
 * Files that are always live regardless of explicit template refs: SOUL.md is
 * `required = true` in every context template; the shared resident/boot set loads
 * for every agent. Seeded into every root's referencedFiles so they never trip the
 * dead-layer rule.
 */
const ALWAYS_LIVE_FILES = new Set([
  'SOUL.md',
  'AGENT_MOTD.md',
  'conventions.md',
  'USER.md',
  'AGENT_ONBOARDING.md',
  'MEMORY.md',
])

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

/** Build a skill unit from a directory that contains SKILL.md. */
async function skillUnit(
  skillDir: string,
  agentId: string | undefined
): Promise<HygieneUnit | null> {
  const skillMd = join(skillDir, 'SKILL.md')
  const content = await readText(skillMd)
  if (content === null) {
    return null
  }
  const name = basename(skillDir)
  const unit: HygieneUnit = {
    kind: 'skill',
    key: `${agentId ?? '_'}/skill:${name}`,
    path: skillMd,
    dir: skillDir,
    regime: 'on-demand',
    content,
    frontmatter: parseSkillFrontmatter(content) ?? {},
  }
  if (agentId !== undefined) {
    unit.agentId = agentId
  }
  return unit
}

/** Build a prompt unit from a single .md file. */
async function promptUnit(
  filePath: string,
  dir: string,
  agentId: string | undefined
): Promise<HygieneUnit | null> {
  const content = await readText(filePath)
  if (content === null) {
    return null
  }
  const unit: HygieneUnit = {
    kind: 'prompt',
    key: `${agentId ?? '_shared'}/prompt:${basename(filePath)}`,
    path: filePath,
    dir,
    regime: promptRegime(filePath),
    content,
  }
  if (agentId !== undefined) {
    unit.agentId = agentId
  }
  return unit
}

/** Enumerate skill directories under a `skills/` dir (one level). */
async function listSkillDirs(skillsDir: string): Promise<string[]> {
  if (!(await isDir(skillsDir))) {
    return []
  }
  let entries: string[]
  try {
    entries = await readdir(skillsDir)
  } catch {
    return []
  }
  const dirs: string[] = []
  for (const entry of entries.sort()) {
    const p = join(skillsDir, entry)
    if (await isFile(join(p, 'SKILL.md'))) {
      dirs.push(p)
    }
  }
  return dirs
}

/**
 * Extract the basenames of every file a live load path references for one agent,
 * so the dead-layer rule can classify agent-root instruction files. Reads the
 * agent's context-template.toml (both local and any shared template alongside it)
 * and agent-profile.toml for `.md` references.
 */
async function collectReferencedFiles(root: string, sharedRoot: string): Promise<Set<string>> {
  const referenced = new Set<string>(ALWAYS_LIVE_FILES)
  const sources = [
    join(root, 'context-template.toml'),
    join(root, 'agent-profile.toml'),
    join(sharedRoot, 'context-template.toml'),
  ]
  for (const src of sources) {
    const text = await readText(src)
    if (text === null) {
      continue
    }
    // path = "agent-root:///SOUL.md" | "AGENT_MOTD.md" | additionalBase = ["foo.md"]
    for (const m of text.matchAll(/([A-Za-z0-9_.-]+\.md)/g)) {
      const name = m[1]
      if (name) {
        referenced.add(name)
      }
    }
  }
  return referenced
}

/** Scan one agent root: its prompt files + skills, plus reference facts. */
async function scanAgentRoot(
  root: string,
  agentId: string,
  sharedRoot: string
): Promise<{ units: HygieneUnit[]; info: AgentRootInfo }> {
  const units: HygieneUnit[] = []

  for (const file of KNOWN_PROMPT_FILES) {
    const p = join(root, file)
    if (await isFile(p)) {
      const unit = await promptUnit(p, root, agentId)
      if (unit) {
        units.push(unit)
      }
    }
  }

  for (const skillDir of await listSkillDirs(join(root, 'skills'))) {
    const unit = await skillUnit(skillDir, agentId)
    if (unit) {
      units.push(unit)
    }
  }

  const info: AgentRootInfo = {
    agentId,
    root,
    referencedFiles: await collectReferencedFiles(root, sharedRoot),
  }
  return { units, info }
}

/** List agent ids (subdirs with an agent-profile.toml) under a var/agents tree. */
async function listAgentIds(treeRoot: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(treeRoot)
  } catch {
    return []
  }
  const ids: string[] = []
  for (const entry of entries.sort()) {
    if (await isFile(join(treeRoot, entry, 'agent-profile.toml'))) {
      ids.push(entry)
    }
  }
  return ids
}

/**
 * Scan a filesystem target into a HygieneContext. Target may be:
 *  - a single SKILL.md file or a skill directory
 *  - a single prompt .md file
 *  - an agent root directory (contains agent-profile.toml)
 *  - a var/agents tree (contains agent subdirs with agent-profile.toml)
 */
export async function scanHygieneTarget(target: string): Promise<HygieneContext> {
  // Single file.
  if (await isFile(target)) {
    if (basename(target) === 'SKILL.md') {
      const unit = await skillUnit(join(target, '..'), undefined)
      return { units: unit ? [unit] : [], agentRoots: [] }
    }
    const unit = await promptUnit(target, join(target, '..'), undefined)
    return { units: unit ? [unit] : [], agentRoots: [] }
  }

  if (!(await isDir(target))) {
    return { units: [], agentRoots: [] }
  }

  // A skill directory.
  if (await isFile(join(target, 'SKILL.md'))) {
    const unit = await skillUnit(target, undefined)
    return { units: unit ? [unit] : [], agentRoots: [] }
  }

  // A single agent root.
  if (await isFile(join(target, 'agent-profile.toml'))) {
    const { units, info } = await scanAgentRoot(target, basename(target), join(target, '..'))
    return { units, agentRoots: [info] }
  }

  // A var/agents tree.
  const agentIds = await listAgentIds(target)
  if (agentIds.length > 0) {
    const units: HygieneUnit[] = []
    const agentRoots: AgentRootInfo[] = []
    for (const id of agentIds) {
      const { units: agentUnits, info } = await scanAgentRoot(join(target, id), id, target)
      units.push(...agentUnits)
      agentRoots.push(info)
    }
    // Shared/top-level prompt files.
    for (const file of SHARED_PROMPT_FILES) {
      const p = join(target, file)
      if (await isFile(p)) {
        const unit = await promptUnit(p, target, undefined)
        if (unit) {
          units.push(unit)
        }
      }
    }
    return { units, agentRoots }
  }

  // Fallback: a directory of skills (each subdir with SKILL.md).
  const units: HygieneUnit[] = []
  for (const skillDir of await listSkillDirs(target)) {
    const unit = await skillUnit(skillDir, undefined)
    if (unit) {
      units.push(unit)
    }
  }
  return { units, agentRoots: [] }
}
