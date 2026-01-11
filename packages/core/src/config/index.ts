/**
 * Config file parsers for Agent Spaces v2
 */

// Lock file parser
export {
  LOCK_FILENAME,
  lockFileExists,
  parseLockJson,
  readLockJson,
  serializeLockJson,
} from './lock-json.js'

// Space manifest parser
export { parseSpaceToml, readSpaceToml, serializeSpaceToml } from './space-toml.js'

// Project manifest parser
export {
  parseTargetsToml,
  readTargetsToml,
  serializeTargetsToml,
  TARGETS_FILENAME,
} from './targets-toml.js'

// asp_modules directory helpers
export {
  ASP_MODULES_DIR,
  ASP_MODULES_MCP_CONFIG,
  ASP_MODULES_PLUGINS_DIR,
  ASP_MODULES_SETTINGS,
  aspModulesExists,
  getAspModulesPath,
  getTargetMcpConfigPath,
  getTargetOutputPath,
  getTargetPluginsPath,
  getTargetSettingsPath,
  targetOutputExists,
  // Phase 2: Harness-aware path helpers
  getHarnessOutputPath,
  getHarnessPluginsPath,
  getHarnessMcpConfigPath,
  getHarnessSettingsPath,
  harnessOutputExists,
} from './asp-modules.js'
