/**
 * Parsing helpers shared by hygiene rules: skill frontmatter, body extraction,
 * and load-regime classification.
 *
 * WHY: The mechanical sweep (rubric §2 M1-M4) fixes an exact counted region so
 * figures reproduce: body = frontmatter stripped, description = the `description:`
 * value only. These helpers reproduce that region deterministically.
 */

import { basename } from 'node:path'
import type { HygieneRegime, SkillFrontmatter } from './types.js'

/** Parse the YAML-ish frontmatter block of a SKILL.md (flat key: value only). */
export function parseSkillFrontmatter(content: string): SkillFrontmatter | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match || match[1] === undefined) {
    return null
  }

  const raw: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const colon = line.indexOf(':')
    if (colon === -1) {
      continue
    }
    const key = line.slice(0, colon).trim()
    const value = line.slice(colon + 1).trim()
    if (key) {
      raw[key] = value
    }
  }

  const fm: SkillFrontmatter = {}
  if (raw['name']) {
    fm.name = raw['name']
  }
  if (raw['description']) {
    fm.description = raw['description']
  }
  if (raw['argument-hint']) {
    fm.argumentHint = raw['argument-hint']
  }
  const disable = raw['disable-model-invocation']
  if (disable !== undefined) {
    fm.disableModelInvocation = /^true$/i.test(disable)
  }
  return fm
}

/**
 * Body with the frontmatter block stripped (rubric §2 M3 counted region).
 * If there is no frontmatter the whole content is the body.
 */
export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? content.slice(match[0].length) : content
}

/** Whitespace-delimited word count (matches `wc -w`). */
export function wordCount(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length
}

/** Line count (matches `wc -l`: number of newline-terminated lines). */
export function lineCount(text: string): number {
  if (text === '') {
    return 0
  }
  const matches = text.match(/\n/g)
  return matches ? matches.length : 0
}

/**
 * Prompt files whose basename maps deterministically to a boot regime (loaded
 * once per session as a SessionStart reminder). Everything else identity/instruction
 * shaped defaults to resident.
 *
 * XL0 correction (CROSS-LAYER.md, task comment C-06838): AGENT_MOTD.md and
 * conventions.md are composed INTO the system prompt per-turn via context-template
 * [[prompt]] blocks — they are RESIDENT, not boot.
 */
const BOOT_PROMPT_BASENAMES = new Set(['USER.md', 'AGENT_ONBOARDING.md', 'MEMORY.md'])

/** Classify the load regime of a prompt file by its basename. */
export function promptRegime(pathOrName: string): HygieneRegime {
  const name = basename(pathOrName)
  return BOOT_PROMPT_BASENAMES.has(name) ? 'boot' : 'resident'
}
