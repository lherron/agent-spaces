/**
 * Plugin validation utilities.
 *
 * WHY: Before launching Claude with plugins, we can validate:
 * 1. Plugin directory structure is correct
 * 2. Required files exist (plugin.json)
 * 3. Optional components are valid if present
 *
 * This provides early feedback on configuration issues.
 */

import { constants, access, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Validation result for a single plugin.
 */
export interface PluginValidationResult {
  /** Path to the plugin directory */
  path: string
  /** Whether the plugin is valid */
  valid: boolean
  /** Validation errors (if any) */
  errors: string[]
  /** Validation warnings (non-fatal issues) */
  warnings: string[]
  /** Plugin name from plugin.json (if valid) */
  pluginName?: string | undefined
  /** Plugin version from plugin.json (if present) */
  pluginVersion?: string | undefined
}

/**
 * Plugin.json structure (partial, for validation).
 */
interface PluginJson {
  name?: string
  version?: string
  description?: string
  commands?: string
  agents?: string
  skills?: string
  hooks?: string
}

/**
 * Known component directories in a plugin.
 */
const _COMPONENT_DIRS = ['commands', 'agents', 'skills', 'hooks', 'scripts', 'mcp']

// ============================================================================
// Helper Functions - Directory Validation
// ============================================================================

/**
 * Check if path is an accessible directory.
 */
async function checkIsDirectory(
  pluginDir: string
): Promise<{ isDir: true } | { isDir: false; error: string }> {
  try {
    const stats = await stat(pluginDir)
    if (!stats.isDirectory()) {
      return { isDir: false, error: `Not a directory: ${pluginDir}` }
    }
    return { isDir: true }
  } catch {
    return { isDir: false, error: `Directory not accessible: ${pluginDir}` }
  }
}

// ============================================================================
// Helper Functions - Plugin.json Loading
// ============================================================================

/**
 * Result of loading plugin.json.
 */
type PluginJsonLoadResult = { success: true; json: PluginJson } | { success: false; error: string }

/**
 * Load and parse plugin.json from a plugin directory.
 */
async function loadPluginJson(pluginDir: string): Promise<PluginJsonLoadResult> {
  const pluginJsonPath = join(pluginDir, '.claude-plugin', 'plugin.json')

  try {
    const content = await Bun.file(pluginJsonPath).text()
    const json = JSON.parse(content) as PluginJson
    return { success: true, json }
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return { success: false, error: 'Missing required .claude-plugin/plugin.json file' }
    }
    if (error instanceof SyntaxError) {
      return {
        success: false,
        error: `Invalid JSON in .claude-plugin/plugin.json: ${error.message}`,
      }
    }
    return {
      success: false,
      error: `Cannot read .claude-plugin/plugin.json: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

// ============================================================================
// Helper Functions - Plugin.json Structure Validation
// ============================================================================

/**
 * Validate plugin name field.
 */
function validatePluginName(pluginJson: PluginJson, result: PluginValidationResult): void {
  if (!pluginJson.name) {
    result.valid = false
    result.errors.push("plugin.json missing required 'name' field")
    return
  }

  if (typeof pluginJson.name !== 'string') {
    result.valid = false
    result.errors.push("plugin.json 'name' must be a string")
    return
  }

  result.pluginName = pluginJson.name

  // Validate name format (kebab-case)
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(pluginJson.name)) {
    result.warnings.push(`Plugin name '${pluginJson.name}' should be kebab-case`)
  }
}

/**
 * Validate plugin version field.
 */
function validatePluginVersion(pluginJson: PluginJson, result: PluginValidationResult): void {
  if (!pluginJson.version) {
    return
  }

  if (typeof pluginJson.version !== 'string') {
    result.warnings.push("plugin.json 'version' should be a string")
    return
  }

  result.pluginVersion = pluginJson.version

  // Validate semver format
  if (!/^\d+\.\d+\.\d+/.test(pluginJson.version)) {
    result.warnings.push(`Plugin version '${pluginJson.version}' should be semver format`)
  }
}

// ============================================================================
// Helper Functions - Component Path Validation
// ============================================================================

/**
 * Validate component paths referenced in plugin.json.
 */
async function validateComponentPaths(
  pluginDir: string,
  pluginJson: PluginJson,
  result: PluginValidationResult
): Promise<void> {
  const componentPaths: { key: keyof PluginJson; value: string }[] = [
    { key: 'commands', value: pluginJson.commands || '' },
    { key: 'agents', value: pluginJson.agents || '' },
    { key: 'skills', value: pluginJson.skills || '' },
    { key: 'hooks', value: pluginJson.hooks || '' },
  ]

  for (const { key, value } of componentPaths) {
    if (!value) continue

    // Path should be relative and start with ./
    if (!value.startsWith('./')) {
      result.warnings.push(`plugin.json '${key}' path '${value}' should start with './'`)
    }

    // Check if path exists
    const componentPath = join(pluginDir, value.replace(/^\.\//, ''))
    try {
      await access(componentPath, constants.R_OK)
    } catch {
      result.warnings.push(`plugin.json '${key}' path '${value}' does not exist`)
    }
  }
}

// ============================================================================
// Helper Functions - Hooks Validation
// ============================================================================

/**
 * Check if a command path uses ${CLAUDE_PLUGIN_ROOT}.
 */
function checkHookCommandPath(
  command: string,
  hookName: string,
  result: PluginValidationResult
): void {
  if (command.includes('/') && !command.startsWith('${CLAUDE_PLUGIN_ROOT}')) {
    result.warnings.push(
      `Hook '${hookName}' command path should use \${CLAUDE_PLUGIN_ROOT}: ${command}`
    )
  }
}

/**
 * Validate a single hook configuration object.
 */
function validateSingleHookConfig(
  hookName: string,
  hookConfig: unknown,
  result: PluginValidationResult
): void {
  if (!hookConfig || typeof hookConfig !== 'object' || Array.isArray(hookConfig)) {
    result.warnings.push(`Hook '${hookName}' configuration should be an object`)
    return
  }

  const config = hookConfig as Record<string, unknown>

  // Check command path uses ${CLAUDE_PLUGIN_ROOT}
  const configCommand = config['command']
  if (typeof configCommand === 'string') {
    checkHookCommandPath(configCommand, hookName, result)
  }

  // Check hooks array
  const configHooks = config['hooks']
  if (!Array.isArray(configHooks)) {
    return
  }

  for (const hookDef of configHooks) {
    if (hookDef && typeof hookDef === 'object') {
      const def = hookDef as Record<string, unknown>
      const defCommand = def['command']
      if (typeof defCommand === 'string') {
        checkHookCommandPath(defCommand, hookName, result)
      }
    }
  }
}

/**
 * Validate hooks.json content.
 */
function validateHooksJsonContent(hooksJson: unknown, result: PluginValidationResult): void {
  if (!hooksJson || typeof hooksJson !== 'object' || Array.isArray(hooksJson)) {
    result.errors.push('hooks/hooks.json must be an object')
    result.valid = false
    return
  }

  const hooks = hooksJson as Record<string, unknown>

  for (const [hookName, hookConfig] of Object.entries(hooks)) {
    validateSingleHookConfig(hookName, hookConfig, result)
  }
}

/**
 * Validate the hooks directory if it exists.
 */
async function validateHooksDirectory(
  pluginDir: string,
  result: PluginValidationResult
): Promise<void> {
  const hooksDir = join(pluginDir, 'hooks')

  try {
    const hooksStats = await stat(hooksDir)
    if (!hooksStats.isDirectory()) {
      return
    }
  } catch {
    // hooks directory doesn't exist, which is fine
    return
  }

  // Hooks directory exists, check for hooks.json
  const hooksJsonPath = join(hooksDir, 'hooks.json')
  try {
    await access(hooksJsonPath, constants.R_OK)

    // Validate hooks.json content
    const hooksContent = await Bun.file(hooksJsonPath).text()
    const hooksJson = JSON.parse(hooksContent)
    validateHooksJsonContent(hooksJson, result)
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      result.warnings.push('hooks/ directory exists but hooks/hooks.json is missing')
    } else if (error instanceof SyntaxError) {
      result.errors.push(`Invalid JSON in hooks/hooks.json: ${error.message}`)
      result.valid = false
    }
  }
}

// ============================================================================
// Main Validation Function
// ============================================================================

/**
 * Validate a single plugin directory.
 *
 * @param pluginDir - Path to the plugin directory
 * @returns Validation result with errors and warnings
 *
 * @example
 * ```typescript
 * const result = await validatePlugin('/path/to/plugin');
 * if (!result.valid) {
 *   console.error('Plugin errors:', result.errors);
 * }
 * if (result.warnings.length > 0) {
 *   console.warn('Plugin warnings:', result.warnings);
 * }
 * ```
 */
export async function validatePlugin(pluginDir: string): Promise<PluginValidationResult> {
  const result: PluginValidationResult = {
    path: pluginDir,
    valid: true,
    errors: [],
    warnings: [],
  }

  // Check if directory exists and is accessible
  const dirCheck = await checkIsDirectory(pluginDir)
  if (!dirCheck.isDir) {
    result.valid = false
    result.errors.push(dirCheck.error)
    return result
  }

  // Load and parse plugin.json
  const loadResult = await loadPluginJson(pluginDir)
  if (!loadResult.success) {
    result.valid = false
    result.errors.push(loadResult.error)
    return result
  }

  const pluginJson = loadResult.json

  // Validate plugin.json structure
  validatePluginName(pluginJson, result)
  validatePluginVersion(pluginJson, result)

  // Validate component paths
  await validateComponentPaths(pluginDir, pluginJson, result)

  // Validate hooks directory
  await validateHooksDirectory(pluginDir, result)

  return result
}

// ============================================================================
// Multiple Plugin Validation
// ============================================================================

/**
 * Validate multiple plugin directories.
 *
 * @param pluginDirs - Array of plugin directory paths
 * @returns Array of validation results
 */
export async function validatePlugins(pluginDirs: string[]): Promise<PluginValidationResult[]> {
  return Promise.all(pluginDirs.map(validatePlugin))
}

/**
 * Check for plugin name collisions across multiple plugins.
 *
 * @param results - Validation results from validatePlugins
 * @returns Array of collision warnings
 */
export function checkPluginNameCollisions(results: PluginValidationResult[]): string[] {
  const warnings: string[] = []
  const nameToPath = new Map<string, string[]>()

  for (const result of results) {
    if (result.pluginName) {
      const paths = nameToPath.get(result.pluginName) || []
      paths.push(result.path)
      nameToPath.set(result.pluginName, paths)
    }
  }

  for (const [name, paths] of nameToPath) {
    if (paths.length > 1) {
      warnings.push(
        `Plugin name collision: '${name}' is used by multiple plugins:\n  ${paths.join('\n  ')}`
      )
    }
  }

  return warnings
}

/**
 * Validate plugins and check for collisions.
 *
 * @param pluginDirs - Array of plugin directory paths
 * @returns Combined validation result
 */
export async function validatePluginsWithCollisionCheck(pluginDirs: string[]): Promise<{
  results: PluginValidationResult[]
  collisions: string[]
  allValid: boolean
}> {
  const results = await validatePlugins(pluginDirs)
  const collisions = checkPluginNameCollisions(results)
  const allValid = results.every((r) => r.valid)

  return { results, collisions, allValid }
}
