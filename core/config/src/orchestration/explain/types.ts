/**
 * Shared types for the explain pipeline (data acquisition, composition, presentation).
 */

import type { SpaceKey } from '../../core/index.js'
import type { LintWarning } from '../../lint/index.js'
import type { ComponentDir, McpServerConfig } from '../../materializer/index.js'
import type { ResolveOptions } from '../resolve.js'

/**
 * Settings defined in a space.
 */
export interface SpaceSettingsInfo {
  /** Permission rules to allow tool use */
  allow?: string[] | undefined
  /** Permission rules to deny tool use */
  deny?: string[] | undefined
  /** Environment variables */
  env?: Record<string, string> | undefined
  /** Model override */
  model?: string | undefined
}

/**
 * Component content found in a space.
 */
export interface SpaceComponentInfo {
  /** Available component directories */
  components: ComponentDir[]
  /** Commands (slash commands) found */
  commands: string[]
  /** Skills found */
  skills: string[]
  /** Agents found */
  agents: string[]
  /** Scripts found */
  scripts: string[]
}

/**
 * Simplified hook info for display.
 */
export interface HookInfo {
  event: string
  count: number
}

/**
 * Space information for explanation.
 */
export interface SpaceInfo {
  /** Space key */
  key: SpaceKey
  /** Space ID */
  id: string
  /** Commit SHA */
  commit: string
  /** Plugin name */
  pluginName: string
  /** Plugin version (if any) */
  pluginVersion?: string | undefined
  /** Content integrity */
  integrity: string
  /** Path in registry */
  path: string
  /** Dependencies */
  deps: SpaceKey[]
  /** How this version was resolved */
  resolvedFrom?: {
    selector?: string
    tag?: string
    semver?: string
  }
  /** Whether snapshot exists in store */
  inStore: boolean
  /** Hooks defined in this space */
  hooks?: HookInfo[] | undefined
  /** MCP servers defined in this space */
  mcpServers?: Record<string, McpServerConfig> | undefined
  /** Settings defined in this space */
  settings?: SpaceSettingsInfo | undefined
  /** Component content */
  content?: SpaceComponentInfo | undefined
}

/**
 * Composed content across all spaces in a target.
 */
export interface ComposedContent {
  /** All hooks from all spaces (in load order) */
  hooks: Array<{ space: string; hook: HookInfo }>
  /** Composed MCP servers (later spaces override) */
  mcpServers: Record<string, { space: string; config: McpServerConfig }>
  /** Composed settings */
  settings: {
    /** All allow rules (concatenated) */
    allow: Array<{ space: string; rule: string }>
    /** All deny rules (concatenated) */
    deny: Array<{ space: string; rule: string }>
    /** All env vars (later override earlier) */
    env: Record<string, { space: string; value: string }>
    /** Model (last one wins) */
    model?: { space: string; value: string } | undefined
  }
  /** All commands across spaces */
  commands: Array<{ space: string; name: string }>
  /** All skills across spaces */
  skills: Array<{ space: string; name: string }>
  /** All agents across spaces */
  agents: Array<{ space: string; name: string }>
}

/**
 * Target explanation.
 */
export interface TargetExplanation {
  /** Target name */
  name: string
  /** Original compose list */
  compose: string[]
  /** Root space keys */
  roots: SpaceKey[]
  /** Load order (dependencies first) */
  loadOrder: SpaceKey[]
  /** Environment hash */
  envHash: string
  /** Detailed space info in load order */
  spaces: SpaceInfo[]
  /** Composed content from all spaces */
  composed: ComposedContent
  /** Warnings */
  warnings: LintWarning[]
}

/**
 * Full explanation output.
 */
export interface ExplainResult {
  /** Registry URL */
  registryUrl: string
  /** Lock file version */
  lockVersion: number
  /** When lock was generated */
  generatedAt: string
  /** Target explanations */
  targets: Record<string, TargetExplanation>
}

/**
 * Options for explain operation.
 */
export interface ExplainOptions extends ResolveOptions {
  /** Specific targets to explain (default: all) */
  targets?: string[] | undefined
  /** Whether to check store for snapshots (default: true) */
  checkStore?: boolean | undefined
  /** Whether to run lint checks (default: true) */
  runLint?: boolean | undefined
}
