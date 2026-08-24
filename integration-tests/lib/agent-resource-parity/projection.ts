import { lstat, readFile, readdir, readlink } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'

import { type Skill, formatSkillsForPrompt } from '@earendil-works/pi-coding-agent'

import type { ParityRunMode, ParitySkill, ProjectedFile, ResourceProjection } from './types.js'

function logicalSkillPath(skill: Skill, roots: readonly string[]): `skill://${string}/SKILL.md` {
  const root = roots.find((candidate) => skill.filePath.startsWith(`${resolve(candidate)}${sep}`))
  if (root === undefined)
    throw new Error(`Selected skill is outside declared ASP roots: ${skill.filePath}`)
  return `skill://${relative(resolve(root), skill.filePath).split(sep).join('/')}`
}

async function projectTree(root: string): Promise<ProjectedFile[]> {
  const entries: ProjectedFile[] = []
  async function visit(path: string): Promise<void> {
    const stat = await lstat(path)
    const rel = relative(root, path).split(sep).join('/') || '.'
    if (stat.isSymbolicLink()) {
      entries.push({ path: rel, kind: 'symlink', target: await readlink(path) })
      return
    }
    if (stat.isDirectory()) {
      entries.push({ path: rel, kind: 'directory' })
      for (const child of (await readdir(path)).sort()) await visit(resolve(path, child))
      return
    }
    if (stat.isFile()) {
      entries.push({
        path: rel,
        kind: 'file',
        bytes: await readFile(path),
        executable: (stat.mode & 0o111) !== 0,
      })
    }
  }
  await visit(root)
  return entries
}

export async function projectResources(input: {
  agentId: string
  mode: ParityRunMode
  prompt: { mode: 'append' | 'replace'; content: string }
  reminder?: string | undefined
  skills: Skill[]
  skillRoots: string[]
}): Promise<ResourceProjection> {
  const catalog: ParitySkill[] = input.skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    disableModelInvocation: skill.disableModelInvocation,
    filePath: logicalSkillPath(skill, input.skillRoots),
  }))
  const packages = new Map<string, ProjectedFile[]>()
  for (const skill of input.skills)
    packages.set(skill.name, await projectTree(resolve(skill.filePath, '..')))
  const logicalSkills = input.skills.map((skill, index) => {
    const entry = catalog[index]
    if (entry === undefined)
      throw new Error(`Missing logical catalog entry for skill: ${skill.name}`)
    return { ...skill, filePath: entry.filePath }
  })
  return {
    agentId: input.agentId,
    mode: input.mode,
    prompt: { mode: input.prompt.mode, content: Buffer.from(input.prompt.content, 'utf8') },
    reminder:
      input.reminder === undefined
        ? { present: false }
        : { present: true, content: Buffer.from(input.reminder, 'utf8') },
    skills: {
      catalog,
      catalogText: Buffer.from(formatSkillsForPrompt(logicalSkills), 'utf8'),
      packages,
    },
  }
}
