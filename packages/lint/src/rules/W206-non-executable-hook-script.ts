/**
 * W206: Non-executable hook script detection.
 *
 * WHY: Hook scripts need to be executable for Claude to run them.
 * We warn about scripts that aren't executable so users can fix permissions.
 */

import { constants, access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'

interface HooksConfig {
  hooks: Array<{
    event: string
    script: string
  }>
}

/**
 * Read hooks.json from a plugin directory.
 */
async function readHooksConfig(pluginPath: string): Promise<HooksConfig | null> {
  const hooksJsonPath = join(pluginPath, 'hooks', 'hooks.json')

  try {
    const content = await readFile(hooksJsonPath, 'utf-8')
    return JSON.parse(content) as HooksConfig
  } catch {
    return null
  }
}

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
 * W206: Detect non-executable hook scripts.
 */
export async function checkHookScriptsExecutable(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const config = await readHooksConfig(space.pluginPath)
    if (config === null || !config.hooks || !Array.isArray(config.hooks)) {
      continue
    }

    for (const hook of config.hooks) {
      const scriptPath = join(space.pluginPath, 'hooks', hook.script)

      // Check if script exists
      if (!(await fileExists(scriptPath))) {
        // This is an error, not a warning - skip (will be caught by W204 or other validation)
        continue
      }

      // Check if executable
      if (!(await isExecutable(scriptPath))) {
        warnings.push({
          code: WARNING_CODES.NON_EXECUTABLE_HOOK_SCRIPT,
          message: `Hook script is not executable: ${hook.script}`,
          severity: 'warning',
          spaceKey: space.key,
          path: scriptPath,
          details: {
            event: hook.event,
            script: hook.script,
          },
        })
      }
    }
  }

  return warnings
}
