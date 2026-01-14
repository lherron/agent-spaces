/**
 * W204: Invalid or missing hooks configuration.
 *
 * WHY: When a hooks/ directory exists but neither hooks.toml nor hooks.json
 * is valid, the hooks won't be registered with the harness.
 *
 * Supports both hooks.toml (harness-agnostic) and hooks.json (legacy).
 * hooks.toml takes precedence over hooks.json when both exist.
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readHooksWithPrecedence } from 'spaces-materializer'
import type { LintContext, LintWarning } from '../types.js'
import { WARNING_CODES } from '../types.js'

/**
 * Check if hooks directory exists.
 */
async function hooksDirectoryExists(pluginPath: string): Promise<boolean> {
  const hooksDir = join(pluginPath, 'hooks')
  try {
    const stats = await stat(hooksDir)
    return stats.isDirectory()
  } catch {
    return false
  }
}

/**
 * Validate hooks configuration (supports both hooks.toml and hooks.json).
 */
async function validateHooksConfig(
  pluginPath: string
): Promise<{ valid: boolean; source?: 'toml' | 'json' | 'none'; error?: string }> {
  const hooksDir = join(pluginPath, 'hooks')

  try {
    const result = await readHooksWithPrecedence(hooksDir)

    // Check if any hooks were found
    if (result.hooks.length === 0 && result.source === 'none') {
      return {
        valid: false,
        source: 'none',
        error: 'Neither hooks.toml nor hooks.json found in hooks directory',
      }
    }

    // Validate hook definitions
    for (const hook of result.hooks) {
      if (!hook.event) {
        return {
          valid: false,
          source: result.source as 'toml' | 'json',
          error: 'Hook definition missing event field',
        }
      }
      if (!hook.script) {
        return {
          valid: false,
          source: result.source as 'toml' | 'json',
          error: `Hook for event '${hook.event}' missing script field`,
        }
      }
    }

    return { valid: true, source: result.source as 'toml' | 'json' }
  } catch (err) {
    return {
      valid: false,
      source: 'none',
      error: `Failed to read hooks configuration: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * W204: Detect invalid or missing hooks configuration.
 */
export async function checkHooksConfig(context: LintContext): Promise<LintWarning[]> {
  const warnings: LintWarning[] = []

  for (const space of context.spaces) {
    // Only check if hooks directory exists
    if (!(await hooksDirectoryExists(space.pluginPath))) {
      continue
    }

    const result = await validateHooksConfig(space.pluginPath)
    if (!result.valid) {
      const configFile =
        result.source === 'toml' ? 'hooks.toml' : result.source === 'json' ? 'hooks.json' : 'hooks'
      warnings.push({
        code: WARNING_CODES.INVALID_HOOKS_CONFIG,
        message: `hooks/ directory exists but hooks configuration is invalid: ${result.error}`,
        severity: 'error',
        spaceKey: space.key,
        path: join(space.pluginPath, 'hooks', configFile),
        details: {
          error: result.error,
          source: result.source,
        },
      })
    }
  }

  return warnings
}
