import { existsSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename, join } from 'node:path'

import {
  type AgentLocalComponents,
  type AgentRuntimeProfile,
  type ClaudeOptions,
  type CodexOptions,
  type SpaceRefString,
  type TargetDefinition,
  getAgentRootsForProject,
  getAgentsRoot,
  mergeAgentWithProjectTarget,
  parseAgentProfile,
  resolveAgentPrimingPrompt,
} from 'spaces-config'
// Internal legacy seam (EN-15986): the v1 run path resolves adapter ids with
// the pre-cutover catalog. T-08702 deletes it with the v1 flow.
import { type HarnessId, isHarnessId } from 'spaces-config'

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

export interface LoadedAgentProfile {
  agentRoot: string
  profile: AgentRuntimeProfile
}

/** Run-time defaults resolved from an agent profile merged with a project target. */
export interface AgentRunDefaults {
  yolo?: boolean
  remoteControl?: boolean
  model?: string
  harness?: string
  claude?: ClaudeOptions
  codex?: CodexOptions
  compose?: SpaceRefString[]
}

export async function detectAgentLocalComponents(
  agentRoot: string
): Promise<AgentLocalComponents | undefined> {
  const skillsDir = join(agentRoot, 'skills')
  const commandsDir = join(agentRoot, 'commands')
  const toolsDir = join(agentRoot, 'tools')
  const toolsBinDir = join(toolsDir, 'bin')
  const agentVarDir = join(agentRoot, 'var')
  const hasSkills = await isDirectory(skillsDir)
  const hasCommands = await isDirectory(commandsDir)
  const hasTools = await isDirectory(toolsBinDir)

  if (!hasSkills && !hasCommands && !hasTools) {
    return undefined
  }

  return {
    agentRoot,
    agentName: basename(agentRoot),
    hasSkills,
    hasCommands,
    hasTools,
    skillsDir,
    commandsDir,
    toolsDir,
    toolsBinDir,
    agentVarDir,
  }
}

export function loadAgentProfileForRun(
  targetName: string,
  options?: {
    agentsRoot?: string | undefined
    agentRoots?: string[] | undefined
    projectRoot?: string | undefined
    aspHome?: string | undefined
  }
): LoadedAgentProfile | undefined {
  const agentRoots =
    options?.agentRoots ??
    (options?.agentsRoot
      ? [options.agentsRoot]
      : getAgentRootsForProject(options?.projectRoot, {
          ...(options?.aspHome ? { aspHome: options.aspHome } : {}),
        }))
  if (agentRoots.length === 0) {
    const agentsRoot = getAgentsRoot()
    if (!agentsRoot) {
      return undefined
    }
    agentRoots.push(agentsRoot)
  }

  const agentsRoot = agentRoots.find((root) =>
    existsSync(join(root, targetName, 'agent-profile.toml'))
  )
  if (!agentsRoot) {
    return undefined
  }

  const agentRoot = join(agentsRoot, targetName)
  const profilePath = join(agentRoot, 'agent-profile.toml')
  if (!existsSync(profilePath)) {
    return undefined
  }
  const profileSource = readFileSync(profilePath, 'utf8')

  return {
    agentRoot,
    profile: parseAgentProfile(profileSource, profilePath),
  }
}

export function resolveProfileHarnessForRun(harness: string | undefined): HarnessId | undefined {
  if (harness === undefined) return undefined
  if (isHarnessId(harness)) return harness
  throw new Error(
    `Invalid harness "${harness}". Must be one of: agent-harness, claude, codex, muse`
  )
}

export function resolveAgentPrimingPromptForRun(
  target:
    | {
        priming?: string | undefined
        priming_append?: string | undefined
      }
    | undefined,
  agentProfile: LoadedAgentProfile | undefined
): string | undefined {
  if (target?.priming !== undefined) {
    return target.priming
  }

  const basePrompt = agentProfile
    ? resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
    : undefined

  if (target?.priming_append) {
    if (basePrompt) {
      return `${basePrompt}\n${target.priming_append}`
    }
    return target.priming_append
  }

  return basePrompt
}

export function resolveAgentRunDefaultsFromProfile(
  target: TargetDefinition | undefined,
  agentProfile: LoadedAgentProfile
): AgentRunDefaults {
  const primingPrompt = resolveAgentPrimingPrompt(agentProfile.profile, agentProfile.agentRoot)
  const effective = mergeAgentWithProjectTarget(
    {
      ...agentProfile.profile,
      ...(primingPrompt !== undefined ? { priming: primingPrompt } : {}),
    },
    target,
    'task'
  )

  return {
    yolo: effective.yolo,
    remoteControl: effective.remoteControl,
    ...(effective.harness !== undefined ? { harness: effective.harness } : {}),
    claude: effective.claude,
    codex: effective.codex,
    compose: effective.compose,
    ...(effective.model !== undefined ? { model: effective.model } : {}),
  }
}

export function resolveAgentRunDefaults(
  targetName: string,
  target: TargetDefinition | undefined,
  options?: Parameters<typeof loadAgentProfileForRun>[1]
): AgentRunDefaults | undefined {
  const agentProfile = loadAgentProfileForRun(targetName, options)
  if (!agentProfile) {
    return undefined
  }
  return resolveAgentRunDefaultsFromProfile(target, agentProfile)
}
