/**
 * Project targets types for Agent Spaces v2
 *
 * The project manifest (asp-targets.toml) defines Run Targets
 * that compose Spaces for project-local execution.
 */

import type { SpaceRefString } from './refs.js'

/** Claude CLI options */
export interface ClaudeOptions {
  /** Model to use */
  model?: string | undefined
  /** Permission mode */
  permission_mode?: string | undefined
  /** Pass-through CLI args to claude */
  args?: string[] | undefined
}

/** Resolver configuration for a target */
export interface ResolverConfig {
  /** Whether to use locked versions (default: true) */
  locked?: boolean
  /** Allow running with dirty working tree (default: true) */
  allow_dirty?: boolean
}

/** A Run Target definition */
export interface TargetDefinition {
  /** Human-readable description */
  description?: string
  /** Ordered list of space refs to compose */
  compose: SpaceRefString[]
  /** Target-specific claude options (override defaults) */
  claude?: ClaudeOptions
  /** Resolver configuration */
  resolver?: ResolverConfig
}

/**
 * Project manifest (asp-targets.toml)
 *
 * Defines the project-level composition surface for Spaces.
 */
export interface ProjectManifest {
  /** Schema version (currently 1) */
  schema: 1
  /** Default claude options for all targets */
  claude?: ClaudeOptions
  /** Named targets */
  targets: Record<string, TargetDefinition>
}

// ============================================================================
// Helper types and functions
// ============================================================================

/** Target name (key in targets map) */
export type TargetName = string

/** Get all target names from a project manifest */
export function getTargetNames(manifest: ProjectManifest): TargetName[] {
  return Object.keys(manifest.targets)
}

/** Get a target by name, or undefined if not found */
export function getTarget(
  manifest: ProjectManifest,
  name: TargetName
): TargetDefinition | undefined {
  return manifest.targets[name]
}

/** Merge claude options (target overrides defaults) */
export function mergeClaudeOptions(
  defaults: ClaudeOptions | undefined,
  overrides: ClaudeOptions | undefined
): ClaudeOptions {
  if (!defaults && !overrides) return {}
  if (!defaults) return { ...overrides }
  if (!overrides) return { ...defaults }

  return {
    model: overrides.model ?? defaults.model,
    permission_mode: overrides.permission_mode ?? defaults.permission_mode,
    args: overrides.args ?? defaults.args,
  }
}

/** Get effective claude options for a target */
export function getEffectiveClaudeOptions(
  manifest: ProjectManifest,
  targetName: TargetName
): ClaudeOptions {
  const target = manifest.targets[targetName]
  if (!target) {
    throw new Error(`Target not found: ${targetName}`)
  }
  return mergeClaudeOptions(manifest.claude, target.claude)
}
