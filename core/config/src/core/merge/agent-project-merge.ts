import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROVISIONING_SCALAR_KEYS, type ProvisioningScalars } from 'agent-scope'
import type { HarnessSelectionRequest } from 'spaces-runtime-contracts'

import { ConfigValidationError } from '../errors.js'
import type { ValidationError } from '../schemas/index.js'
import type { AgentRuntimeProfile, RunMode } from '../types/agent-profile.js'
import type { SpaceRefString } from '../types/refs.js'
import { type TargetDefinition, mergeClaudeOptions, mergeCodexOptions } from '../types/targets.js'
import type { ClaudeOptions, CodexOptions } from '../types/targets.js'

export interface EffectiveTargetConfig {
  priming?: string | undefined
  compose: SpaceRefString[]
  yolo: boolean
  remoteControl: boolean
  /** Merged harness selection; absent when neither layer declares one (the resolver defaults it). */
  harness?: string | undefined
  model_provider?: string | undefined
  model?: string | undefined
  reasoning_effort?: string | undefined
  /**
   * Merged presentation. Absent stays absent: only an explicit false is
   * preserved (by property presence, never truthiness). Config never defaults
   * this — the central resolver applies the catalog default.
   */
  presentation?: boolean | undefined
  sandbox?: string | undefined
  approval?: string | undefined
  claude: ClaudeOptions
  codex: CodexOptions
  description?: string | undefined
  /** Canonical scalar-keyed provisioning result; target values override agent values. */
  provisioning: ProvisioningScalars
}

/**
 * One wire-spelled selection layer for the central resolver. Property
 * presence is preserved exactly (including explicit `presentation: false`)
 * so precedence and provenance resolve per layer in the compiler.
 */
export type SelectionWireLayer = Partial<HarnessSelectionRequest>

export interface MergedSelectionLayers {
  agentProfile?: SelectionWireLayer | undefined
  projectTarget?: SelectionWireLayer | undefined
  summonDirectives?: SelectionWireLayer | undefined
}

/** Selection keys in TOML/directive (snake) spelling and their wire (camel) spelling. */
const SELECTION_KEY_MAP = {
  harness: 'harness',
  model_provider: 'modelProvider',
  model: 'model',
  reasoning_effort: 'reasoningEffort',
  presentation: 'presentation',
} as const

type SelectionSnakeKey = keyof typeof SELECTION_KEY_MAP

function toWireLayer(scalars: ProvisioningScalars | undefined): SelectionWireLayer | undefined {
  if (scalars === undefined) return undefined
  const layer: SelectionWireLayer = {}
  let present = false
  for (const [snake, wire] of Object.entries(SELECTION_KEY_MAP)) {
    const key = snake as SelectionSnakeKey
    if (Object.hasOwn(scalars, key)) {
      const value = scalars[key]
      if (value !== undefined) {
        Object.assign(layer, { [wire]: value })
        present = true
      }
    }
  }
  return present ? layer : undefined
}

/**
 * Build the wire-spelled selection layers for the central resolver from the
 * three config-side scalar homes: agent profile, project target, and parsed
 * summon directives. Translation is spelling only (`model_provider` to
 * `modelProvider`); defaults, compatibility, and driver mapping resolve
 * centrally, never here.
 */
export function toSelectionLayers(
  agentProvisioning: AgentRuntimeProfile['provisioning'],
  targetProvisioning: TargetDefinition['provisioning'],
  directives?: Partial<ProvisioningScalars> | undefined
): MergedSelectionLayers {
  const agentProfile = toWireLayer(agentProvisioning)
  const projectTarget = toWireLayer(targetProvisioning)
  const summonDirectives = toWireLayer(directives)
  return {
    ...(agentProfile !== undefined ? { agentProfile } : {}),
    ...(projectTarget !== undefined ? { projectTarget } : {}),
    ...(summonDirectives !== undefined ? { summonDirectives } : {}),
  }
}

function mergeProvisioningScalars(
  agentProvisioning: AgentRuntimeProfile['provisioning'],
  targetProvisioning: TargetDefinition['provisioning']
): ProvisioningScalars {
  const merged: Record<string, string | boolean> = {}

  for (const key of PROVISIONING_SCALAR_KEYS) {
    const value = targetProvisioning?.[key] ?? agentProvisioning?.[key]
    if (value !== undefined) {
      merged[key] = value
    }
  }

  // These two booleans have always defaulted to false in the effective merge.
  // Keep that per-key behavior without materializing defaults for absent
  // selection scalars such as presentation, whose absence is meaningful to
  // the central resolver (omitted receives the catalog default; only an
  // explicit false is preserved, by property presence above).
  merged['yolo'] ??= false
  merged['remote'] ??= false

  return merged as ProvisioningScalars
}

function conflict(path: string, message: string): ConfigValidationError {
  const errors: ValidationError[] = [{ path, message, keyword: 'conflict', params: {} }]
  return new ConfigValidationError('Invalid target override', 'asp-targets.toml', errors)
}

function normalizeSpaceRef(ref: SpaceRefString): string {
  return ref.replace(/@dev$/, '')
}

function deduplicateSpaces(refs: readonly SpaceRefString[]): SpaceRefString[] {
  const seen = new Set<string>()
  const result: SpaceRefString[] = []

  for (const ref of refs) {
    const key = normalizeSpaceRef(ref)
    if (seen.has(key)) {
      continue
    }
    seen.add(key)
    result.push(ref)
  }

  return result
}

function getAgentCompose(profile: AgentRuntimeProfile, runMode: RunMode): SpaceRefString[] {
  return deduplicateSpaces([
    ...(profile.spaces?.base ?? []),
    ...(profile.spaces?.modes?.[runMode] ?? []),
  ])
}

export function resolveEffectiveCompose(
  profile: AgentRuntimeProfile,
  projectTarget: TargetDefinition | undefined,
  runMode: RunMode
): SpaceRefString[] {
  const agentCompose = getAgentCompose(profile, runMode)

  if (!projectTarget || !projectTarget.compose || projectTarget.compose.length === 0) {
    return agentCompose
  }

  if (projectTarget.compose_mode === 'merge') {
    return deduplicateSpaces([...agentCompose, ...projectTarget.compose])
  }

  return [...projectTarget.compose]
}

export function mergePrimingPrompt(
  agentDefault: string | undefined,
  projectTarget: TargetDefinition | undefined
): string | undefined {
  if (!projectTarget) {
    return agentDefault
  }
  if (projectTarget.priming !== undefined && projectTarget.priming_append !== undefined) {
    throw conflict(
      '/targets/<target>',
      'cannot set both priming and priming_append on the same target'
    )
  }
  if (projectTarget.priming !== undefined) {
    return projectTarget.priming
  }
  if (projectTarget.priming_append !== undefined && agentDefault) {
    return `${agentDefault}\n${projectTarget.priming_append}`
  }
  return agentDefault
}

export function resolveAgentPrimingPrompt(
  profile: AgentRuntimeProfile,
  agentRoot: string
): string | undefined {
  if (profile.priming) {
    return profile.priming
  }
  if (profile.priming_file) {
    return readFileSync(join(agentRoot, profile.priming_file), 'utf8')
  }
  return undefined
}

export function mergeAgentWithProjectTarget(
  profile: AgentRuntimeProfile,
  projectTarget: TargetDefinition | undefined,
  runMode: RunMode
): EffectiveTargetConfig {
  const agentProvisioning = profile.provisioning
  const targetProvisioning = projectTarget?.provisioning
  const provisioning = mergeProvisioningScalars(agentProvisioning, targetProvisioning)
  const reasoningEffort = provisioning.reasoning_effort
  const sandbox = provisioning.sandbox
  const approval = provisioning.approval
  const claude = mergeClaudeOptions(agentProvisioning?.claude, targetProvisioning?.claude)
  const codex = mergeCodexOptions(agentProvisioning?.codex, targetProvisioning?.codex)
  if (reasoningEffort !== undefined) codex.model_reasoning_effort = reasoningEffort
  if (sandbox !== undefined) codex.sandbox_mode = sandbox as CodexOptions['sandbox_mode']
  if (approval !== undefined) codex.approval_policy = approval as CodexOptions['approval_policy']

  return {
    priming: mergePrimingPrompt(profile.priming, projectTarget),
    compose: resolveEffectiveCompose(profile, projectTarget, runMode),
    yolo: provisioning.yolo ?? false,
    remoteControl: provisioning.remote ?? false,
    ...(provisioning.harness !== undefined ? { harness: provisioning.harness } : {}),
    ...(provisioning.model_provider !== undefined
      ? { model_provider: provisioning.model_provider }
      : {}),
    ...(provisioning.model !== undefined ? { model: provisioning.model } : {}),
    ...(reasoningEffort !== undefined ? { reasoning_effort: reasoningEffort } : {}),
    ...(Object.hasOwn(provisioning, 'presentation') && provisioning.presentation !== undefined
      ? { presentation: provisioning.presentation }
      : {}),
    sandbox,
    approval,
    claude,
    codex,
    description: projectTarget?.description,
    provisioning,
  }
}

export { mergeClaudeOptions, mergeCodexOptions }
