/**
 * E208: SKILL.md missing frontmatter.
 *
 * WHY: SKILL.md files must have YAML frontmatter with `name` and `description`
 * fields for proper skill discovery and documentation.
 *
 * Expected format:
 * ```
 * ---
 * name: skill-name
 * description: What this skill does
 * ---
 * # Content...
 * ```
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'

/**
 * Parse YAML frontmatter from markdown content.
 * Returns the parsed frontmatter object or null if invalid/missing.
 */
function parseFrontmatter(content: string): Record<string, string> | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match || !match[1]) {
    return null
  }

  const frontmatter: Record<string, string> = {}
  const lines = match[1].split(/\r?\n/)

  for (const line of lines) {
    const colonIndex = line.indexOf(':')
    if (colonIndex === -1) continue

    const key = line.slice(0, colonIndex).trim()
    const value = line.slice(colonIndex + 1).trim()

    if (key && value) {
      frontmatter[key] = value
    }
  }

  return frontmatter
}

/**
 * Check if a path exists and is a directory.
 */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Check if a path exists and is a file.
 */
async function isFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * E208: Check that all SKILL.md files have frontmatter with name and description.
 */
export async function checkSkillMdFrontmatter(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const skillsDir = join(space.pluginPath, 'skills')

    // Check if skills directory exists
    if (!(await isDirectory(skillsDir))) {
      continue
    }

    // List all skill directories
    let skillDirs: string[]
    try {
      skillDirs = await readdir(skillsDir)
    } catch {
      continue
    }

    for (const skillDir of skillDirs) {
      const skillPath = join(skillsDir, skillDir)

      // Skip if not a directory
      if (!(await isDirectory(skillPath))) {
        continue
      }

      const skillMdPath = join(skillPath, 'SKILL.md')

      // Check if SKILL.md exists
      if (!(await isFile(skillMdPath))) {
        continue
      }

      // Read and parse SKILL.md
      let content: string
      try {
        content = await readFile(skillMdPath, 'utf-8')
      } catch {
        continue
      }

      const frontmatter = parseFrontmatter(content)

      if (!frontmatter) {
        warnings.push({
          code: WARNING_CODES.SKILL_MD_MISSING_FRONTMATTER,
          message: `SKILL.md is missing frontmatter. Add YAML frontmatter with 'name' and 'description' fields.`,
          severity: 'error',
          spaceKey: space.key,
          path: skillMdPath,
          details: {
            skill: skillDir,
            expected: '---\nname: <skill-name>\ndescription: <description>\n---',
          },
        })
        continue
      }

      const missingFields: string[] = []
      if (!frontmatter['name']) {
        missingFields.push('name')
      }
      if (!frontmatter['description']) {
        missingFields.push('description')
      }

      if (missingFields.length > 0) {
        warnings.push({
          code: WARNING_CODES.SKILL_MD_MISSING_FRONTMATTER,
          message: `SKILL.md frontmatter is missing required field(s): ${missingFields.join(', ')}`,
          severity: 'error',
          spaceKey: space.key,
          path: skillMdPath,
          details: {
            skill: skillDir,
            missingFields,
            currentFrontmatter: frontmatter,
          },
        })
      }
    }
  }

  return warnings
}
