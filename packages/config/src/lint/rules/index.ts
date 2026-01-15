/**
 * All lint rules.
 *
 * WHY: Central export for all lint rules.
 */

export { checkCommandCollisions } from './W201-command-collision.js'
export { checkAgentCommandNamespace } from './W202-agent-command-namespace.js'
export { checkHookPaths } from './W203-hook-path-no-plugin-root.js'
export { checkHooksConfig } from './W204-invalid-hooks-config.js'
export { checkPluginNameCollisions } from './W205-plugin-name-collision.js'
export { checkHookScriptsExecutable } from './W206-non-executable-hook-script.js'
export { checkPluginStructure } from './W207-invalid-plugin-structure.js'

import type { LintRule } from '../types.js'
import { checkCommandCollisions } from './W201-command-collision.js'
import { checkAgentCommandNamespace } from './W202-agent-command-namespace.js'
import { checkHookPaths } from './W203-hook-path-no-plugin-root.js'
import { checkHooksConfig } from './W204-invalid-hooks-config.js'
import { checkPluginNameCollisions } from './W205-plugin-name-collision.js'
import { checkHookScriptsExecutable } from './W206-non-executable-hook-script.js'
import { checkPluginStructure } from './W207-invalid-plugin-structure.js'

/**
 * All lint rules in execution order.
 */
export const allRules: LintRule[] = [
  checkCommandCollisions,
  checkAgentCommandNamespace,
  checkHookPaths,
  checkHooksConfig,
  checkPluginNameCollisions,
  checkHookScriptsExecutable,
  checkPluginStructure,
]
