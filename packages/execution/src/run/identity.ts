/**
 * Run identity + system-prompt materialization helpers for the project-target
 * `run()` pipeline.
 *
 * Extracted from `run.ts` to keep that function a thin orchestration pipeline:
 * `resolveRunIdentity` derives the agent/project/task identity and the expanded
 * effective prompt, and `materializeRunSystemPrompt` collapses the system-prompt
 * materialization (previously six mutable `let` budget variables) into a single
 * result object.
 */

import { basename, dirname } from 'node:path'

import { inferProjectIdFromCwd } from 'spaces-config'
import { expandTemplate, materializeSystemPrompt } from 'spaces-runtime'

import type { LoadedAgentProfile } from './agent-profile.js'
import type { MaterializedPromptResult } from './execute.js'
import { combinePrompts } from './util.js'

const DEFAULT_RUN_TASK_ID = 'primary'

export interface RunIdentity {
  agentId: string | undefined
  projectId: string
  taskId: string
  expansionContext: Record<string, unknown> | undefined
  effectivePrompt: string | undefined
}

export interface ResolveRunIdentityArgs {
  agentProfile: LoadedAgentProfile | undefined
  projectPath: string
  aspHome: string | undefined
  defaultPrompt: string | undefined
  userPrompt: string | undefined
  projectId: string | undefined
  taskId: string | undefined
  env?: NodeJS.ProcessEnv | undefined
}

/**
 * Derive the agent/project/task identity for a run and the final prompt after
 * template expansion. Mirrors the prior inline logic byte-for-byte; identity
 * fallbacks read `ASP_PROJECT` / `ASP_TASK_ID` from the injected env.
 */
export function resolveRunIdentity(args: ResolveRunIdentityArgs): RunIdentity {
  const { agentProfile, projectPath, aspHome } = args
  const env = args.env ?? process.env
  const combinedPrompt = combinePrompts(args.defaultPrompt, args.userPrompt)
  const agentId = agentProfile ? basename(agentProfile.agentRoot) : undefined
  const projectId =
    args.projectId ??
    env['ASP_PROJECT'] ??
    inferProjectIdFromCwd({
      cwd: projectPath,
      ...(aspHome !== undefined ? { aspHome } : {}),
    }) ??
    basename(projectPath)
  const taskId = args.taskId ?? env['ASP_TASK_ID'] ?? DEFAULT_RUN_TASK_ID
  const expansionContext = agentProfile
    ? {
        agentRoot: agentProfile.agentRoot,
        agentsRoot: dirname(agentProfile.agentRoot),
        agentId,
        agentName: agentId,
        projectRoot: projectPath,
        projectId,
        taskId,
        runMode: 'query',
      }
    : undefined
  const effectivePrompt =
    combinedPrompt !== undefined && expansionContext !== undefined
      ? expandTemplate(combinedPrompt, expansionContext)
      : combinedPrompt

  return { agentId, projectId, taskId, expansionContext, effectivePrompt }
}

/**
 * Grouped prompt-budget metadata surfaced on `RunResult` from a materialized
 * system prompt. Replaces the six mutable `let` variables previously threaded
 * through `run()`.
 */
export interface RunSystemPromptBudget {
  reminderContent?: string | undefined
  maxChars?: number | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  nearMaxChars?: boolean | undefined
}

export interface MaterializeRunSystemPromptResult {
  budget: RunSystemPromptBudget
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
  reminderContent?: string | undefined
}

export interface MaterializeRunSystemPromptArgs {
  agentProfile: LoadedAgentProfile
  harnessOutputPath: string
  agentId: string | undefined
  projectPath: string
  projectId: string
  taskId: string
}

/**
 * Materialize the agent system prompt for a run, returning the system-prompt
 * launch fields and the grouped prompt budget as a single object. Behavior is
 * preserved from the prior inline block in `run()`.
 */
export async function materializeRunSystemPrompt(
  args: MaterializeRunSystemPromptArgs
): Promise<MaterializeRunSystemPromptResult> {
  const systemPrompt = await materializeSystemPrompt(args.harnessOutputPath, {
    agentRoot: args.agentProfile.agentRoot,
    ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    projectRoot: args.projectPath,
    projectId: args.projectId,
    taskId: args.taskId,
    runMode: 'query',
  })

  if (!systemPrompt) {
    return { budget: {} }
  }

  const materializedPrompt = systemPrompt as MaterializedPromptResult
  const budget: RunSystemPromptBudget = {
    reminderContent: materializedPrompt.reminderContent,
    maxChars: materializedPrompt.maxChars,
    promptSectionSizes: materializedPrompt.promptSectionSizes,
    reminderSectionSizes: materializedPrompt.reminderSectionSizes,
    totalContextChars: materializedPrompt.totalContextChars,
    nearMaxChars: materializedPrompt.nearMaxChars,
  }

  return {
    budget,
    ...(materializedPrompt.content.length > 0
      ? { systemPrompt: materializedPrompt.content, systemPromptMode: materializedPrompt.mode }
      : {}),
    ...(materializedPrompt.reminderContent
      ? { reminderContent: materializedPrompt.reminderContent }
      : {}),
  }
}
