/**
 * W206: Non-executable hook script detection.
 *
 * WHY: Hook scripts need to be executable for Claude to run them.
 * We warn about scripts that aren't executable so users can fix permissions.
 */

import { constants, access, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'
import { readHooksJson } from './hooks-json.js'

const CLAUDE_PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'

/**
 * Check if a file is executable.
 */
async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Check if a file exists.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile()
  } catch {
    return false
  }
}

/**
 * Normalize script paths that start with hooks/.
 */
function normalizeScriptPath(scriptPath: string): string {
  return scriptPath.replace(/^hooks\//, '')
}

/**
 * Extract a script path from a Claude hook command.
 */
function extractScriptPath(command: string): string | null {
  const marker = `${CLAUDE_PLUGIN_ROOT}/`
  const index = command.indexOf(marker)
  if (index === -1) {
    return null
  }

  const remainder = command.slice(index + marker.length)
  const path = remainder.split(/\s+/)[0] ?? ''
  if (!path) {
    return null
  }

  return normalizeScriptPath(path)
}

/**
 * W206: Detect non-executable hook scripts.
 */
export async function checkHookScriptsExecutable(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const parsed = await readHooksJson(space.pluginPath)
    if (parsed === null) {
      continue
    }

    const hooksDir = join(space.pluginPath, 'hooks')
    const scriptPaths: string[] = []

    for (const hook of parsed.scripts) {
      if (!hook.script) continue
      scriptPaths.push(normalizeScriptPath(hook.script))
    }

    for (const hook of parsed.commands) {
      if (!hook.command) continue
      const scriptPath = extractScriptPath(hook.command)
      if (scriptPath) {
        scriptPaths.push(scriptPath)
      }
    }

    for (const script of scriptPaths) {
      const scriptPath = join(hooksDir, script)

      // Check if script exists
      if (!(await fileExists(scriptPath))) {
        // This is an error, not a warning - skip (will be caught by W204 or other validation)
        continue
      }

      // Check if executable
      if (!(await isExecutable(scriptPath))) {
        warnings.push({
          code: WARNING_CODES.NON_EXECUTABLE_HOOK_SCRIPT,
          message: `Hook script is not executable: ${script}`,
          severity: 'warning',
          spaceKey: space.key,
          path: scriptPath,
          details: {
            script,
          },
        })
      }
    }
  }

  return warnings
}
