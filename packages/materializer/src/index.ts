/**
 * Plugin materialization for Agent Spaces v2.
 *
 * WHY: Materialization transforms space snapshots into Claude plugin
 * directories. This involves:
 * - Generating plugin.json from space manifest
 * - Linking component directories from store
 * - Validating and fixing hook scripts
 * - Composing MCP configurations
 * - Caching for fast subsequent runs
 */

// Plugin.json generation
export {
  generatePluginJson,
  writePluginJson,
  getPluginJsonPath,
  type PluginJson,
} from './plugin-json.js'

// Component linking
export {
  linkFile,
  linkDirectory,
  linkComponents,
  isDirectory,
  getAvailableComponents,
  COMPONENT_DIRS,
  type ComponentDir,
  type LinkOptions,
} from './link-components.js'

// Hooks validation
export {
  readHooksConfig,
  isExecutable,
  makeExecutable,
  validateHooks,
  ensureHooksExecutable,
  checkHookPaths,
  type HookDefinition,
  type HooksConfig,
  type HookValidationResult,
} from './hooks-builder.js'

// MCP composition
export {
  readMcpConfig,
  composeMcpConfigs,
  checkMcpCollisions,
  writeMcpConfig,
  readAllMcpConfigs,
  composeMcpFromSpaces,
  type McpServerConfig,
  type McpConfig,
} from './mcp-composer.js'

// Settings composition
export {
  composeSettings,
  composeSettingsFromSpaces,
  isEmptySettings,
  writeSettingsFile,
  type ComposedSettings,
  type SettingsInput,
} from './settings-composer.js'

// Main materialization
export {
  materializeSpace,
  materializeSpaces,
  materializeWithMcp,
  getPluginPaths,
  type MaterializeInput,
  type MaterializeResult,
  type MaterializeOptions,
  type FullMaterializationResult,
} from './materialize.js'
