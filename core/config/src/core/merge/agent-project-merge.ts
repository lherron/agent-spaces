import { readFileSync } from 'node:fs'
import { join } from 'node:path'

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
  harness: string
  model?: string | undefined
  reasoning?: string | undefined
  sandbox?: string | undefined
  approval?: string | undefined
  claude: ClaudeOptions
  codex: CodexOptions
  description?: string | undefined
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
  const reasoning = targetProvisioning?.reasoning ?? agentProvisioning?.reasoning
  const sandbox = targetProvisioning?.sandbox ?? agentProvisioning?.sandbox
  const approval = targetProvisioning?.approval ?? agentProvisioning?.approval
  const claude = mergeClaudeOptions(agentProvisioning?.claude, targetProvisioning?.claude)
  const codex = mergeCodexOptions(agentProvisioning?.codex, targetProvisioning?.codex)
  if (reasoning !== undefined) codex.model_reasoning_effort = reasoning
  if (sandbox !== undefined) codex.sandbox_mode = sandbox as CodexOptions['sandbox_mode']
  if (approval !== undefined) codex.approval_policy = approval as CodexOptions['approval_policy']

  return {
    priming: mergePrimingPrompt(profile.priming, projectTarget),
    compose: resolveEffectiveCompose(profile, projectTarget, runMode),
    yolo: targetProvisioning?.yolo ?? agentProvisioning?.yolo ?? false,
    remoteControl: targetProvisioning?.remote ?? agentProvisioning?.remote ?? false,
    harness: targetProvisioning?.harness ?? agentProvisioning?.harness ?? 'claude-code',
    model: targetProvisioning?.model ?? agentProvisioning?.model,
    reasoning,
    sandbox,
    approval,
    claude,
    codex,
    description: projectTarget?.description,
  }
}

export { mergeClaudeOptions, mergeCodexOptions }
