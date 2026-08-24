import type {
  AgentInspectionDiagnostic,
  AgentInspectionPart,
  AgentInspectionResult,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'

import { type ForegroundLaunch, foregroundLaunchFromResponse } from './foreground-launch.js'

export interface StableAgentCompileIdentity {
  compileId: string
  planHash: string
  lockHash: string | null
  bundleIdentity: string
}

export interface AgentCompileDryRunProjection {
  accepted: boolean
  promptBytes: string
  sectionOrder: string[]
  capabilities: AgentInspectionPart[]
  runtimeSettings: AgentInspectionPart[]
  diagnostics: AgentInspectionDiagnostic[]
  identity: StableAgentCompileIdentity
}

export interface RuntimeCompileDryRunProjection {
  accepted: boolean
  foreground?: ForegroundLaunch | undefined
  diagnostics?: string[] | undefined
}

type RuntimeProjectionInput = {
  response: RuntimeCompileResponse
}

type InspectionProjectionInput = RuntimeProjectionInput & {
  inspection: AgentInspectionResult
}

/**
 * Project one canonical compile for the dry-run consumer.
 *
 * The response-only overload is the projection used by the live `asp run`
 * bridge. Contextual inspection passes its already-produced inspection into
 * the second overload to compare the richer effective-agent view without
 * invoking the compiler again.
 */
export function projectAgentCompileForDryRun(
  input: InspectionProjectionInput
): AgentCompileDryRunProjection
export function projectAgentCompileForDryRun(
  input: RuntimeProjectionInput
): RuntimeCompileDryRunProjection
export function projectAgentCompileForDryRun(
  input: RuntimeProjectionInput | InspectionProjectionInput
): RuntimeCompileDryRunProjection | AgentCompileDryRunProjection {
  const runtime = projectRuntimeResponse(input.response)
  if (!('inspection' in input)) return runtime

  if (!input.response.ok) {
    throw new Error('An inspection projection requires a successful canonical compile response')
  }

  const promptParts = input.inspection.parts.filter((part) => part.kind === 'prompt')
  return {
    accepted: runtime.accepted && input.inspection.completeness.kind === 'complete',
    promptBytes: promptParts
      .filter(
        (part) =>
          part.kind === 'prompt' &&
          part.disposition.kind === 'effective' &&
          part.value.zone === 'prompt'
      )
      .map((part) => (part.kind === 'prompt' ? (part.value.content ?? '') : ''))
      .join('\n\n---\n\n'),
    sectionOrder: promptParts.map((part) => part.partId),
    capabilities: input.inspection.parts.filter((part) => part.kind === 'capability'),
    runtimeSettings: input.inspection.parts.filter((part) => part.kind === 'runtime-setting'),
    diagnostics: input.inspection.diagnostics,
    identity: {
      compileId: input.response.plan.compileId,
      planHash: input.response.plan.planHash,
      lockHash: input.response.plan.artifacts.lockHash ?? null,
      bundleIdentity: input.response.plan.artifacts.bundleIdentity,
    },
  }
}

function projectRuntimeResponse(response: RuntimeCompileResponse): RuntimeCompileDryRunProjection {
  const foreground = foregroundLaunchFromResponse(response)
  return {
    accepted: response.ok,
    ...(foreground !== undefined ? { foreground } : {}),
    ...(response.ok
      ? {}
      : { diagnostics: response.diagnostics.map((item) => `${item.code}: ${item.message}`) }),
  }
}
