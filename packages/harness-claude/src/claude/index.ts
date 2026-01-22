/**
 * spaces-claude - Claude CLI wrapper
 *
 * This package provides safe, typed interfaces for:
 * - Detecting and validating Claude installations
 * - Invoking Claude with plugin directories
 * - Validating plugin structure
 *
 * Key design decisions:
 * - Use argv arrays for safety (prevents command injection)
 * - Support ASP_CLAUDE_PATH for testing with shims
 * - Provide both interactive and programmatic invocation modes
 */

// Detection
export {
  detectClaude,
  findClaudeBinary,
  getClaudePath,
  clearClaudeCache,
  type ClaudeInfo,
} from './detect.js'

// Invocation
export {
  invokeClaude,
  invokeClaudeOrThrow,
  runClaudePrompt,
  spawnClaude,
  buildClaudeArgs,
  formatClaudeCommand,
  getClaudeCommand,
  type ClaudeInvocationResult,
  type ClaudeInvokeOptions,
  type SpawnClaudeOptions,
} from './invoke.js'

// Validation
export {
  validatePlugin,
  validatePlugins,
  checkPluginNameCollisions,
  validatePluginsWithCollisionCheck,
  type PluginValidationResult,
} from './validate.js'
