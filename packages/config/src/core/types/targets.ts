/**
 * Project targets types for Agent Spaces v3
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
export type CodexReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none'

export interface CodexOptions {
  /** Model to use */
  model?: string | undefined
  /** Model reasoning effort override */
  model_reasoning_effort?: string | undefined
  /** Model reasoning summary mode */
  model_reasoning_summary?: CodexReasoningSummary | undefined
  /** Ordered TUI status-line item identifiers, mapped to `tui.status_line` */
  status_line?: string[] | undefined
  /** Approval policy */
  approval_policy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  /** Sandbox mode */
  sandbox_mode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  /** Profile name */
  profile?: string | undefined
}

/** Birth-time defaults shared by agent profiles and project target overlays. */
export interface ProvisioningSettings {
  harness?: string | undefined
  model?: string | undefined
  reasoning?: string | undefined
  node?: string | undefined
  yolo?: boolean | undefined
  sandbox?: string | undefined
  approval?: string | undefined
  remote?: boolean | undefined
  /** Harness escape hatches are profile/target configuration, never directive scalars. */
  claude?: ClaudeOptions | undefined
  codex?: CodexOptions | undefined
}

/** The structurally overridable, top-level scalar portion of provisioning. */
export type ProvisioningScalars = Omit<ProvisioningSettings, 'claude' | 'codex'>

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
  description?: string | undefined
  /** Initial prompt sent when running this target unless overridden by CLI prompt */
  priming?: string | undefined
  /** Prompt text to append to the agent-level priming prompt */
  priming_append?: string | undefined
  /** Ordered list of space refs to compose (optional when agent-profile provides defaults) */
  compose?: SpaceRefString[] | undefined
  /** How project compose should interact with agent-level compose defaults */
  compose_mode?: 'replace' | 'merge' | undefined
  /** Project-local birth defaults overriding the agent profile. */
  provisioning?: ProvisioningSettings | undefined
  /** Resolver configuration */
  resolver?: ResolverConfig | undefined
}

/**
 * Project manifest (asp-targets.toml)
 *
 * Defines the project-level composition surface for Spaces.
 */
export interface ProjectManifest {
  /** Schema version (currently 1) */
  schema: 1
  /** Optional project-local agents root, relative to project root unless absolute or ~-prefixed */
  'agents-root'?: string | undefined
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
    model_reasoning_effort: overrides.model_reasoning_effort ?? defaults.model_reasoning_effort,
    model_reasoning_summary: overrides.model_reasoning_summary ?? defaults.model_reasoning_summary,
    status_line: overrides.status_line ?? defaults.status_line,
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
  const options = mergeClaudeOptions(manifest.claude, target?.provisioning?.claude)
  if (target?.provisioning?.model !== undefined) options.model = target.provisioning.model
  return options
}

/**
 * Merge two project manifests (defaults under project).
 *
 * - Targets: spread defaults.targets under project.targets (project wins entirely per target name)
 * - Top-level claude/codex: field-level merge via mergeClaudeOptions/mergeCodexOptions
 * - If defaults is null/undefined, returns project as-is
 */
export function mergeManifests(
  defaults: ProjectManifest | null | undefined,
  project: ProjectManifest
): ProjectManifest {
  if (defaults == null) return project

  const result: ProjectManifest = {
    schema: 1,
    targets: { ...defaults.targets, ...project.targets },
  }

  if (defaults['agents-root'] || project['agents-root']) {
    result['agents-root'] = project['agents-root'] ?? defaults['agents-root']
  }
  if (defaults.claude || project.claude) {
    result.claude = mergeClaudeOptions(defaults.claude, project.claude)
  }
  if (defaults.codex || project.codex) {
    result.codex = mergeCodexOptions(defaults.codex, project.codex)
  }

  return result
}

/** Get effective codex options for a target */
export function getEffectiveCodexOptions(
  manifest: ProjectManifest,
  targetName: TargetName
): CodexOptions {
  const target = manifest.targets[targetName]
  const options = mergeCodexOptions(manifest.codex, target?.provisioning?.codex)
  const provisioning = target?.provisioning
  if (provisioning?.model !== undefined) options.model = provisioning.model
  if (provisioning?.reasoning !== undefined) {
    options.model_reasoning_effort = provisioning.reasoning
  }
  if (provisioning?.approval !== undefined) {
    options.approval_policy = provisioning.approval as CodexOptions['approval_policy']
  }
  if (provisioning?.sandbox !== undefined) {
    options.sandbox_mode = provisioning.sandbox as CodexOptions['sandbox_mode']
  }
  return options
}
