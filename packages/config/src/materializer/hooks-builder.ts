/**
 * Hooks validation and building.
 *
 * WHY: Hooks allow spaces to execute scripts in response to Claude events.
 * We need to validate hooks.json exists and scripts are executable.
 *
 * Supports three formats:
 * 1. Simple format: {hooks: [{event, script}, ...]}
 * 2. Claude array format: {hooks: [{matcher, hooks: [{command}, ...]}, ...]}
 * 3. Claude object format: {hooks: {PreToolUse: [{matcher, hooks: [{command}, ...]}], ...}}
 */

import { constants, access, chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Hook definition from hooks.json (simple format).
 */
export interface HookDefinition {
  /** Event type to trigger on */
  event: string
  /** Script path relative to hooks directory */
  script: string
  /** Optional timeout in milliseconds */
  timeout?: number | undefined
}

/**
 * Claude's native hook definition.
 */
export interface ClaudeNativeHookDefinition {
  /** Event matcher (e.g., 'PreToolUse', 'PostToolUse', 'Stop') */
  matcher?: string | undefined
  /** Array of hook configurations */
  hooks: Array<{
    /** Command path (may use ${CLAUDE_PLUGIN_ROOT}) */
    command?: string | undefined
    /** Optional timeout in milliseconds */
    timeout_ms?: number | undefined
    /** Optional timeout in seconds */
    timeout?: number | undefined
  }>
}

/**
 * Claude object format: hooks keyed by event name.
 */
export type ClaudeHooksByEvent = Record<string, ClaudeNativeHookDefinition[]>

/**
 * Hooks configuration file structure.
 * Supports both simple and Claude's native format.
 */
export interface HooksConfig {
  /** Array of hook definitions (simple format) */
  hooks: HookDefinition[] | ClaudeNativeHookDefinition[] | ClaudeHooksByEvent
}

/**
 * Hook validation result.
 */
export interface HookValidationResult {
  /** Whether all hooks are valid */
  valid: boolean
  /** List of validation errors */
  errors: string[]
  /** List of validation warnings */
  warnings: string[]
}

/**
 * Normalized hook for validation purposes.
 */
interface NormalizedHook {
  /** Script path relative to hooks directory */
  script: string
}

/**
 * Read and parse hooks.json from a directory.
 */
export async function readHooksConfig(dir: string): Promise<HooksConfig | null> {
  const hooksJsonPath = join(dir, 'hooks', 'hooks.json')

  try {
    const content = await readFile(hooksJsonPath, 'utf-8')
    return JSON.parse(content) as HooksConfig
  } catch {
    return null
  }
}

/**
 * Check if hooks config is in Claude's native array format.
 */
function isClaudeNativeArrayFormat(
  hooks: HooksConfig['hooks']
): hooks is ClaudeNativeHookDefinition[] {
  if (!Array.isArray(hooks) || hooks.length === 0) {
    return false
  }
  const first = hooks[0]
  return (
    first !== undefined &&
    typeof first === 'object' &&
    first !== null &&
    'hooks' in first &&
    Array.isArray((first as ClaudeNativeHookDefinition).hooks)
  )
}

/**
 * Normalize hooks to a common format for validation.
 */
function normalizeHooks(config: HooksConfig): NormalizedHook[] {
  if (!config.hooks) {
    return []
  }

  if (Array.isArray(config.hooks)) {
    if (isClaudeNativeArrayFormat(config.hooks)) {
      const normalized: NormalizedHook[] = []
      for (const hook of config.hooks) {
        for (const cmd of hook.hooks ?? []) {
          if (cmd.command) {
            const script = cmd.command
              .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '')
              .replace(/^hooks\//, '')
            normalized.push({ script })
          }
        }
      }
      return normalized
    }

    // Simple format: use script directly
    return (config.hooks as HookDefinition[]).map((h) => ({ script: h.script }))
  }

  if (typeof config.hooks === 'object') {
    const normalized: NormalizedHook[] = []
    for (const eventHooks of Object.values(config.hooks)) {
      if (!Array.isArray(eventHooks)) continue
      for (const hook of eventHooks) {
        for (const cmd of hook.hooks ?? []) {
          if (cmd.command) {
            // Extract script path from command
            // ${CLAUDE_PLUGIN_ROOT}/hooks/script.sh -> hooks/script.sh
            const script = cmd.command
              .replace(/^\$\{CLAUDE_PLUGIN_ROOT\}\//, '')
              .replace(/^hooks\//, '') // Remove hooks/ prefix if present
            normalized.push({ script })
          }
        }
      }
    }
    return normalized
  }

  return []
}

/**
 * Check if a file is executable.
 */
export async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Make a file executable.
 */
export async function makeExecutable(path: string): Promise<void> {
  const stats = await stat(path)
  // Add execute permission for user, group, and others
  await chmod(path, stats.mode | 0o111)
}

/**
 * Validate hooks in a directory.
 */
export async function validateHooks(dir: string): Promise<HookValidationResult> {
  const result: HookValidationResult = {
    valid: true,
    errors: [],
    warnings: [],
  }

  const hooksDir = join(dir, 'hooks')

  // Check if hooks directory exists
  try {
    const stats = await stat(hooksDir)
    if (!stats.isDirectory()) {
      return result // No hooks, that's fine
    }
  } catch {
    return result // No hooks directory
  }

  // Check for hooks.json
  const config = await readHooksConfig(dir)
  if (config === null) {
    result.warnings.push('hooks/ directory exists but hooks.json is missing or invalid')
    return result
  }

  // Check that hooks content exists and is valid
  if (
    !config.hooks ||
    (!Array.isArray(config.hooks) && (typeof config.hooks !== 'object' || config.hooks === null))
  ) {
    result.warnings.push('hooks.json is missing or has invalid hooks content')
    return result
  }

  // Normalize hooks for validation (handles both simple and Claude native formats)
  const normalizedHooks = normalizeHooks(config)

  // Validate each hook
  for (const hook of normalizedHooks) {
    if (!hook.script) {
      result.warnings.push('Hook definition has empty script path')
      continue
    }

    const scriptPath = join(hooksDir, hook.script)

    // Check script exists
    try {
      const stats = await stat(scriptPath)
      if (!stats.isFile()) {
        result.errors.push(`Hook script is not a file: ${hook.script}`)
        result.valid = false
        continue
      }
    } catch {
      result.errors.push(`Hook script not found: ${hook.script}`)
      result.valid = false
      continue
    }

    // Check script is executable
    if (!(await isExecutable(scriptPath))) {
      result.warnings.push(`Hook script is not executable: ${hook.script}`)
    }
  }

  return result
}

/**
 * Ensure all hook scripts in a directory are executable.
 */
export async function ensureHooksExecutable(dir: string): Promise<void> {
  const config = await readHooksConfig(dir)
  if (config === null || !config.hooks || !Array.isArray(config.hooks)) {
    return
  }

  const hooksDir = join(dir, 'hooks')

  // Normalize hooks (handles both simple and Claude native formats)
  const normalizedHooks = normalizeHooks(config)

  for (const hook of normalizedHooks) {
    if (!hook.script) continue

    const scriptPath = join(hooksDir, hook.script)
    try {
      if (!(await isExecutable(scriptPath))) {
        await makeExecutable(scriptPath)
      }
    } catch {
      // Script might not exist, ignore
    }
  }
}

/**
 * Check if hooks.json contains paths without ${CLAUDE_PLUGIN_ROOT}.
 * This is a warning because relative paths may not work correctly.
 */
export function checkHookPaths(config: HooksConfig): string[] {
  const warnings: string[] = []

  if (!config.hooks || !Array.isArray(config.hooks)) {
    return warnings
  }

  // Normalize hooks (handles both simple and Claude native formats)
  const normalizedHooks = normalizeHooks(config)

  for (const hook of normalizedHooks) {
    // This is a simple heuristic - in real usage, we'd check if paths
    // in the script reference files without using CLAUDE_PLUGIN_ROOT
    if (hook.script?.includes('..')) {
      warnings.push(`Hook script uses relative path that may not work: ${hook.script}`)
    }
  }

  return warnings
}
