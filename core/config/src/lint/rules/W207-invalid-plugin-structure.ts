/**
 * W207: Invalid plugin structure.
 *
 * WHY: Claude Code expects component directories (commands/, agents/, skills/, hooks/)
 * at the plugin root, NOT inside .claude-plugin/. If directories are nested inside
 * .claude-plugin/, Claude will not discover them.
 */

import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'

/** Component directories that should be at plugin root, not inside .claude-plugin/ */
const COMPONENT_DIRS = ['commands', 'agents', 'skills', 'hooks', 'scripts']

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
 * W207: Detect component directories incorrectly nested inside .claude-plugin/.
 */
export async function checkPluginStructure(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const claudePluginDir = join(space.pluginPath, '.claude-plugin')

    // Check if .claude-plugin directory exists
    if (!(await isDirectory(claudePluginDir))) {
      continue
    }

    // Check for component directories inside .claude-plugin
    let nestedDirs: string[]
    try {
      nestedDirs = await readdir(claudePluginDir)
    } catch {
      continue
    }

    for (const dir of nestedDirs) {
      if (COMPONENT_DIRS.includes(dir)) {
        const nestedPath = join(claudePluginDir, dir)
        if (await isDirectory(nestedPath)) {
          warnings.push({
            code: WARNING_CODES.INVALID_PLUGIN_STRUCTURE,
            message: `Component directory '${dir}/' found inside .claude-plugin/. It should be at plugin root.`,
            severity: 'warning',
            spaceKey: space.key,
            path: nestedPath,
            details: {
              directory: dir,
              correctLocation: join(space.pluginPath, dir),
              incorrectLocation: nestedPath,
            },
          })
        }
      }
    }
  }

  return warnings
}
