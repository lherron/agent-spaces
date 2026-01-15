/**
 * W203: Hook paths missing ${CLAUDE_PLUGIN_ROOT}.
 *
 * WHY: Hooks that reference files without using ${CLAUDE_PLUGIN_ROOT}
 * may not work correctly when the plugin is installed elsewhere.
 */

import { join } from 'node:path'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'
import { readHooksJson } from './hooks-json.js'

const CLAUDE_PLUGIN_ROOT = '${CLAUDE_PLUGIN_ROOT}'

/**
 * Check if a path contains relative parent references.
 */
function hasRelativePath(scriptPath: string): boolean {
  return scriptPath.includes('..')
}

/**
 * Check if a command uses ${CLAUDE_PLUGIN_ROOT}.
 */
function usesClaudePluginRoot(command: string): boolean {
  return command.includes(CLAUDE_PLUGIN_ROOT)
}

/**
 * Normalize script paths that start with hooks/.
 */
function normalizeScriptPath(scriptPath: string): string {
  return scriptPath.replace(/^hooks\//, '')
}

/**
 * W203: Detect hook scripts or commands missing ${CLAUDE_PLUGIN_ROOT}.
 */
export async function checkHookPaths(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    const parsed = await readHooksJson(space.pluginPath)
    if (parsed === null) {
      continue
    }

    for (const hook of parsed.scripts) {
      if (!hook.script) continue

      // Check for relative parent references in legacy/simple format.
      if (hasRelativePath(hook.script)) {
        warnings.push({
          code: WARNING_CODES.HOOK_PATH_NO_PLUGIN_ROOT,
          message: `Hook script uses relative path that may not work: ${hook.script}`,
          severity: 'warning',
          spaceKey: space.key,
          path: join(space.pluginPath, 'hooks', normalizeScriptPath(hook.script)),
          details: {
            event: hook.event,
            script: hook.script,
          },
        })
      }
    }

    for (const hook of parsed.commands) {
      if (!hook.command) continue

      if (!usesClaudePluginRoot(hook.command)) {
        warnings.push({
          code: WARNING_CODES.HOOK_PATH_NO_PLUGIN_ROOT,
          message: `Hook command missing ${CLAUDE_PLUGIN_ROOT}: ${hook.command}`,
          severity: 'warning',
          spaceKey: space.key,
          path: parsed.sourcePath,
          details: {
            event: hook.event,
            command: hook.command,
          },
        })
      }
    }
  }

  return warnings
}
