/**
 * W203: Hook paths missing ${CLAUDE_PLUGIN_ROOT}.
 *
 * WHY: Hooks that reference files without using ${CLAUDE_PLUGIN_ROOT}
 * may not work correctly when the plugin is installed elsewhere.
 */

import { readFile } from 'node:fs/promises'
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
 * Check if a path contains relative parent references.
 */
function hasRelativePath(scriptPath: string): boolean {
  return scriptPath.includes('..')
}

/**
 * W203: Detect hook scripts that use relative paths without CLAUDE_PLUGIN_ROOT.
 */
export async function checkHookPaths(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const config = await readHooksConfig(space.pluginPath)
    if (config === null || !config.hooks || !Array.isArray(config.hooks)) {
      continue
    }

    for (const hook of config.hooks) {
      // Check for relative parent references
      if (hasRelativePath(hook.script)) {
        warnings.push({
          code: WARNING_CODES.HOOK_PATH_NO_PLUGIN_ROOT,
          message: `Hook script uses relative path that may not work: ${hook.script}`,
          severity: 'warning',
          spaceKey: space.key,
          path: join(space.pluginPath, 'hooks', hook.script),
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
