import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ConfigValidationError } from '../errors.js'
import type { ValidationError } from '../schemas/index.js'
import type { AgentRuntimeProfile, RunMode } from '../types/agent-profile.js'
import type { SpaceRefString } from '../types/refs.js'
import { type TargetDefinition, mergeClaudeOptions, mergeCodexOptions } from '../types/targets.js'
import type { ClaudeOptions, CodexOptions } from '../types/targets.js'

export interface EffectiveTargetConfig {
  priming_prompt?: string | undefined
  compose: SpaceRefString[]
  yolo: boolean
  harness: string
  model?: string | undefined
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
    ...(profile.spaces?.byMode?.[runMode] ?? []),
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
  if (
    projectTarget.priming_prompt !== undefined &&
    projectTarget.priming_prompt_append !== undefined
  ) {
    throw conflict(
      '/targets/<target>',
      'cannot set both priming_prompt and priming_prompt_append on the same target'
    )
  }
  if (projectTarget.priming_prompt !== undefined) {
    return projectTarget.priming_prompt
  }
  if (projectTarget.priming_prompt_append !== undefined && agentDefault) {
    return `${agentDefault}\n${projectTarget.priming_prompt_append}`
  }
  return agentDefault
}

export function resolveAgentPrimingPrompt(
  profile: AgentRuntimeProfile,
  agentRoot: string
): string | undefined {
  if (profile.priming_prompt) {
    return profile.priming_prompt
  }
  if (profile.priming_prompt_file) {
    return readFileSync(join(agentRoot, profile.priming_prompt_file), 'utf8')
  }
  return undefined
}

export function mergeAgentWithProjectTarget(
  profile: AgentRuntimeProfile,
  projectTarget: TargetDefinition | undefined,
  runMode: RunMode
): EffectiveTargetConfig {
  return {
    priming_prompt: mergePrimingPrompt(profile.priming_prompt, projectTarget),
    compose: resolveEffectiveCompose(profile, projectTarget, runMode),
    yolo: projectTarget?.yolo ?? profile.harnessDefaults?.yolo ?? false,
    harness: projectTarget?.harness ?? profile.identity?.harness ?? 'claude-code',
    model:
      projectTarget?.claude?.model ?? projectTarget?.codex?.model ?? profile.harnessDefaults?.model,
    claude: mergeClaudeOptions(profile.harnessDefaults?.claude, projectTarget?.claude),
    codex: mergeCodexOptions(profile.harnessDefaults?.codex, projectTarget?.codex),
    description: projectTarget?.description,
  }
}

export { mergeClaudeOptions, mergeCodexOptions }
