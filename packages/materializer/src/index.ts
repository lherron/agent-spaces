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
  linkInstructionsFile,
  isDirectory,
  getAvailableComponents,
  COMPONENT_DIRS,
  INSTRUCTIONS_FILE_AGNOSTIC,
  INSTRUCTIONS_FILE_CLAUDE,
  type ComponentDir,
  type LinkOptions,
  type LinkInstructionsResult,
} from './link-components.js'

// Hooks validation (legacy hooks.json)
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

// Hooks TOML parsing (canonical harness-agnostic format)
export {
  parseHooksToml,
  readHooksToml,
  hooksTomlExists,
  filterHooksForHarness,
  translateToClaudeEvent,
  translateToPiEvent,
  toClaudeHooksConfig,
  generateClaudeHooksJson,
  writeClaudeHooksJson,
  readHooksWithPrecedence,
  HOOKS_TOML_FILENAME,
  HOOKS_JSON_FILENAME,
  ABSTRACT_TO_CLAUDE_EVENTS,
  ABSTRACT_TO_PI_EVENTS,
  type CanonicalHookDefinition,
  type HooksTomlConfig,
  type ClaudeHookDefinition,
  type ClaudeHooksConfig,
  type ReadHooksResult,
} from './hooks-toml.js'

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

// Permissions TOML parsing (canonical harness-agnostic format)
export {
  parsePermissionsToml,
  readPermissionsToml,
  permissionsTomlExists,
  readPermissions,
  toClaudePermissions,
  toClaudeSettingsPermissions,
  toPiPermissions,
  buildPiToolsList,
  normalizePaths,
  normalizeExecToClaudeRules,
  hasPermissions,
  explainPermissions,
  PERMISSIONS_TOML_FILENAME,
  CLAUDE_ENFORCEMENT,
  PI_ENFORCEMENT,
  type CanonicalPermissions,
  type EnforcementLevel,
  type AnnotatedPermissionFacet,
  type ClaudePermissions,
  type PiPermissions,
  type ClaudeSettingsPermissions,
  type ReadPermissionsResult,
} from './permissions-toml.js'

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
