import { formatSessionRef, laneIdFromRef, normalizeLaneRef, parseScopeRef } from 'agent-scope'
import type { RuntimePlacement } from 'spaces-config'

export const RESERVED_AGENT_SESSION_ENV_KEYS = new Set([
  'AGENT_ID',
  'AGENT_PROJECT',
  'AGENT_TASK',
  'AGENT_LANE',
  'AGENT_SESSION_REF',
  'AGENT_RUN_ID',
  'AGENT_HOST_SESSION_ID',
  'AGENT_PROJECT_ROOT',
  'AGENT_ACTOR',
  'WRKQ_ACTOR',
  'AGENT_SCOPE_REF',
  'AGENT_LANE_REF',
  'ASP_PROJECT_ROOT',
  'HRC_SESSION_REF',
  'HRC_RUN_ID',
  'HRC_HOST_SESSION_ID',
])

export interface BuildAgentSessionEnvOptions {
  actor?: string | undefined
}

function deriveShorthandScopeParts(scopeRef: string): {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
} {
  const atIndex = scopeRef.indexOf('@')
  if (atIndex === -1) return {}
  const agentId = scopeRef.slice(0, atIndex)
  const rest = scopeRef.slice(atIndex + 1)
  const colonIndex = rest.indexOf(':')
  if (agentId.length === 0 || rest.length === 0) return {}
  if (colonIndex === -1) return { agentId, projectId: rest }
  const projectId = rest.slice(0, colonIndex)
  const taskId = rest.slice(colonIndex + 1)
  return {
    agentId,
    ...(projectId.length > 0 ? { projectId } : {}),
    ...(taskId.length > 0 ? { taskId } : {}),
  }
}

export function buildAgentSessionEnv(
  placement: RuntimePlacement,
  options: BuildAgentSessionEnvOptions = {}
): Record<string, string> {
  const env: Record<string, string> = {}
  const sessionRef = placement.correlation?.sessionRef

  let agentId: string | undefined
  let projectId: string | undefined
  let taskId: string | undefined

  if (sessionRef !== undefined) {
    const laneRef = normalizeLaneRef(
      sessionRef.laneRef === 'main' || sessionRef.laneRef.startsWith('lane:')
        ? sessionRef.laneRef
        : `lane:${sessionRef.laneRef}`
    )
    env['AGENT_SCOPE_REF'] = sessionRef.scopeRef
    env['AGENT_LANE_REF'] = sessionRef.laneRef

    const lane = laneIdFromRef(laneRef)
    env['AGENT_LANE'] = lane.length > 0 ? lane : 'main'

    try {
      const parsed = parseScopeRef(sessionRef.scopeRef)
      agentId = parsed.agentId
      projectId = parsed.projectId
      taskId = parsed.taskId
      env['AGENT_SESSION_REF'] = formatSessionRef({ scopeRef: sessionRef.scopeRef, laneRef })
      env['HRC_SESSION_REF'] = env['AGENT_SESSION_REF']
    } catch {
      const shorthand = deriveShorthandScopeParts(sessionRef.scopeRef)
      agentId = shorthand.agentId
      projectId = shorthand.projectId
      taskId = shorthand.taskId
    }
  }

  if (agentId !== undefined) env['AGENT_ID'] = agentId
  if (projectId !== undefined) env['AGENT_PROJECT'] = projectId
  if (taskId !== undefined) env['AGENT_TASK'] = taskId

  if (placement.correlation?.runId !== undefined) {
    env['AGENT_RUN_ID'] = placement.correlation.runId
    env['HRC_RUN_ID'] = placement.correlation.runId
  }
  if (placement.correlation?.hostSessionId !== undefined) {
    env['AGENT_HOST_SESSION_ID'] = placement.correlation.hostSessionId
    env['HRC_HOST_SESSION_ID'] = placement.correlation.hostSessionId
  }
  if (placement.projectRoot !== undefined) {
    env['AGENT_PROJECT_ROOT'] = placement.projectRoot
    env['ASP_PROJECT_ROOT'] = placement.projectRoot
  }

  const actor = options.actor ?? agentId
  if (actor !== undefined && actor.length > 0) {
    env['AGENT_ACTOR'] = actor
    env['WRKQ_ACTOR'] = actor
  }

  return env
}
