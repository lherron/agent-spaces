import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  type AgentLocalComponents,
  type AgentRuntimeProfile,
  type ClaudeOptions,
  type CodexOptions,
  type HarnessId,
  type SpaceRefString,
  type TargetDefinition,
  getAgentsRoot,
  mergeAgentWithProjectTarget,
  normalizeHarnessId,
  parseAgentProfile,
  resolveAgentPrimingPrompt,
} from 'spaces-config'

import { pathExists } from './util.js'

export interface LoadedAgentProfile {
  agentRoot: string
  profile: AgentRuntimeProfile
}

export async function detectAgentLocalComponents(
  agentRoot: string
): Promise<AgentLocalComponents | undefined> {
  const skillsDir = join(agentRoot, 'skills')
  const commandsDir = join(agentRoot, 'commands')
  const hasSkills = await pathExists(skillsDir)
  const hasCommands = await pathExists(commandsDir)

  if (!hasSkills && !hasCommands) {
    return undefined
  }

  return {
    agentRoot,
    hasSkills,
    hasCommands,
    skillsDir,
    commandsDir,
  }
}

export function loadAgentProfileForRun(
  targetName: string,
  options?: { agentsRoot?: string | undefined }
): LoadedAgentProfile | undefined {
  const agentsRoot = options?.agentsRoot ?? getAgentsRoot()
  if (!agentsRoot) {
    return undefined
  }

  const agentRoot = join(agentsRoot, targetName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }
  const profileSource = readFileSync(profilePath, 'utf8').replace(
    /^(\s*)schema_version(\s*=)/m,
    '$1schemaVersion$2'
  )

  return {
    agentRoot,
    profile: parseAgentProfile(profileSource, profilePath),
  }
}

export function resolveProfileHarnessForRun(harness: string | undefined): HarnessId | undefined {
  return normalizeHarnessId(harness)
}

export function resolveAgentPrimingPromptForRun(
  target:
    | {
        priming_prompt?: string | undefined
        priming_prompt_append?: string | undefined
      }
    | undefined,
  agentProfile: LoadedAgentProfile | undefined
): string | undefined {
  if (target?.priming_prompt !== undefined) {
    return target.priming_prompt
  }

  const basePrompt = agentProfile
    ? resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
    : undefined

  if (target?.priming_prompt_append) {
    if (basePrompt) {
      return `${basePrompt}\n${target.priming_prompt_append}`
    }
    return target.priming_prompt_append
  }

  return basePrompt
}

export function resolveAgentRunDefaultsFromProfile(
  target: TargetDefinition | undefined,
  agentProfile: LoadedAgentProfile
): {
  yolo?: boolean
  remoteControl?: boolean
  model?: string
  harness?: string
  claude?: ClaudeOptions
  codex?: CodexOptions
  compose?: SpaceRefString[]
} {
  const primingPrompt = resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
  const effective = mergeAgentWithProjectTarget(
    {
      ...agentProfile.profile,
      ...(primingPrompt !== undefined ? { priming_prompt: primingPrompt } : {}),
    },
    target,
    'task'
  )

  return {
    yolo: effective.yolo,
    remoteControl: effective.remoteControl,
    harness: effective.harness,
    claude: effective.claude,
    codex: effective.codex,
    compose: effective.compose,
    ...(effective.model !== undefined ? { model: effective.model } : {}),
  }
}

export function resolveAgentRunDefaults(
  targetName: string,
  target: TargetDefinition | undefined,
  options?: { agentsRoot?: string | undefined }
):
  | {
      yolo?: boolean
      remoteControl?: boolean
      model?: string
      harness?: string
      claude?: ClaudeOptions
      codex?: CodexOptions
      compose?: SpaceRefString[]
    }
  | undefined {
  const agentProfile = loadAgentProfileForRun(targetName, options)
  if (!agentProfile) {
    return undefined
  }
  return resolveAgentRunDefaultsFromProfile(target, agentProfile)
}
