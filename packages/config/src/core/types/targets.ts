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

/** Codex CLI options */
export interface CodexOptions {
  /** Model to use */
  model?: string | undefined
  /** Approval policy */
  approval_policy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  /** Sandbox mode */
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  /** Profile name */
  profile?: string | undefined
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
  /** Target-specific codex options (override defaults) */
  codex?: CodexOptions
  /** Resolver configuration */
  resolver?: ResolverConfig
  /** Skip all permission prompts (--dangerously-skip-permissions) */
  yolo?: boolean
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
  /** Default codex options for all targets */
  codex?: CodexOptions
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

/** Merge codex options (target overrides defaults) */
export function mergeCodexOptions(
  defaults: CodexOptions | undefined,
  overrides: CodexOptions | undefined
): CodexOptions {
  if (!defaults && !overrides) return {}
  if (!defaults) return { ...overrides }
  if (!overrides) return { ...defaults }

  return {
    model: overrides.model ?? defaults.model,
    approval_policy: overrides.approval_policy ?? defaults.approval_policy,
    sandbox_mode: overrides.sandbox_mode ?? defaults.sandbox_mode,
    profile: overrides.profile ?? defaults.profile,
  }
}

/** Get effective claude options for a target */
export function getEffectiveClaudeOptions(
  manifest: ProjectManifest,
  targetName: TargetName
): ClaudeOptions {
  const target = manifest.targets[targetName]
  if (!target) {
    const available = getTargetNames(manifest)
    const availableStr =
      available.length > 0 ? `Available: ${available.join(', ')}` : 'No targets defined'
    throw new Error(`Target "${targetName}" not found in manifest. ${availableStr}`)
  }
  return mergeClaudeOptions(manifest.claude, target.claude)
}

/** Get effective codex options for a target */
export function getEffectiveCodexOptions(
  manifest: ProjectManifest,
  targetName: TargetName
): CodexOptions {
  const target = manifest.targets[targetName]
  if (!target) {
    const available = getTargetNames(manifest)
    const availableStr =
      available.length > 0 ? `Available: ${available.join(', ')}` : 'No targets defined'
    throw new Error(`Target "${targetName}" not found in manifest. ${availableStr}`)
  }
  return mergeCodexOptions(manifest.codex, target.codex)
}
