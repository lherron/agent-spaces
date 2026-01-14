/**
 * Types for lint rules.
 *
 * WHY: Common types used across all lint rules for consistent warning format.
 */

import type { SpaceKey, SpaceManifest } from 'spaces-core'

/**
 * Warning severity levels.
 * - error: Halts execution
 * - warning: Displayed but doesn't halt
 * - info: Informational only
 */
export type WarningSeverity = 'error' | 'warning' | 'info'

/**
 * A lint warning.
 */
export interface LintWarning {
  /** Warning code (e.g., "W201") */
  code: string
  /** Human-readable message */
  message: string
  /** Severity level */
  severity: WarningSeverity
  /** Related space (if applicable) */
  spaceKey?: SpaceKey | undefined
  /** Related file path (if applicable) */
  path?: string | undefined
  /** Additional details */
  details?: Record<string, unknown> | undefined
}

/**
 * Space data for linting.
 */
export interface SpaceLintData {
  /** Space key */
  key: SpaceKey
  /** Space manifest */
  manifest: SpaceManifest
  /** Path to materialized plugin directory */
  pluginPath: string
}

/**
 * Lint context for rule execution.
 */
export interface LintContext {
  /** All spaces in load order */
  spaces: SpaceLintData[]
}

/**
 * A lint rule function.
 */
export type LintRule = (context: LintContext) => Promise<LintWarning[]> | LintWarning[]

/**
 * Warning codes.
 */
export const WARNING_CODES = {
  /** Info: Lock file was missing and had to be auto-generated */
  LOCK_MISSING: 'W101',
  /** W2xx: Space/plugin lint rules */
  COMMAND_COLLISION: 'W201',
  AGENT_COMMAND_NAMESPACE: 'W202',
  HOOK_PATH_NO_PLUGIN_ROOT: 'W203',
  INVALID_HOOKS_CONFIG: 'W204',
  PLUGIN_NAME_COLLISION: 'W205',
  NON_EXECUTABLE_HOOK_SCRIPT: 'W206',
  INVALID_PLUGIN_STRUCTURE: 'W207',
  /** W3xx: Harness-specific warnings (Pi = W301-W310) */
  PI_HOOK_CANNOT_BLOCK: 'W301',
  PI_UNNAMESPACED_TOOL: 'W302',
  PI_TOOL_COLLISION: 'W303',
  PI_PERMISSION_LINT_ONLY: 'W304',
} as const

export type WarningCode = (typeof WARNING_CODES)[keyof typeof WARNING_CODES]
