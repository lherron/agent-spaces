/**
 * Hooks validation and building.
 *
 * WHY: Hooks allow spaces to execute scripts in response to Claude events.
 * We need to validate hooks.json exists and scripts are executable.
 */

import { constants, access, chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Hook definition from hooks.json.
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
 * Hooks configuration file structure.
 */
export interface HooksConfig {
  /** Array of hook definitions */
  hooks: HookDefinition[]
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

  // Check that hooks array exists and is valid
  if (!config.hooks || !Array.isArray(config.hooks)) {
    result.warnings.push('hooks.json is missing or has invalid hooks array')
    return result
  }

  // Validate each hook
  for (const hook of config.hooks) {
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

  for (const hook of config.hooks) {
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

  for (const hook of config.hooks) {
    // This is a simple heuristic - in real usage, we'd check if paths
    // in the script reference files without using CLAUDE_PLUGIN_ROOT
    if (hook.script.includes('..')) {
      warnings.push(`Hook script uses relative path that may not work: ${hook.script}`)
    }
  }

  return warnings
}
