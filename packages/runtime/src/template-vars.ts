import type { ContextResolverContext } from './context-resolver.js'

const ENV_PREFIX = 'env.'

/**
 * Canonical template variables, keyed by their primary (camelCase) name. Every
 * value lives here exactly once; the surface names that authors may use are
 * derived from {@link VARIABLE_ALIASES} so a variable never has to be spelled
 * out in three naming conventions by hand.
 */
function buildCanonicalVariables(context: ContextResolverContext): Record<string, string> {
  const agentName = context.agentName ?? getAgentNameFromProfile(context.agentProfile) ?? ''
  const agentId = context.agentId ?? agentName
  const projectId = context.projectId ?? ''
  const taskId = context.taskId ?? ''
  const lane = context.lane ?? ''
  const scopeRef = buildScopeRef(agentId, projectId, taskId)
  const handle = buildHandle(agentId, projectId, taskId, lane)
  const now = context.now ?? new Date()

  return {
    agentId,
    agentName,
    projectId,
    taskId,
    scopeRef,
    handle,
    lane,
    runMode: context.runMode,
    date: formatLocalDate(now),
    dateUtc: now.toISOString(),
    agentRoot: context.agentRoot,
    agentsRoot: context.agentsRoot,
    projectRoot: context.projectRoot ?? '',
  }
}

/**
 * Alias name -> canonical variable name. Authors may reference any of these
 * surface spellings (snake_case, `path.*` namespace, and legacy names); they
 * all resolve to the single canonical value. The canonical names themselves are
 * always available in addition to their aliases.
 */
const VARIABLE_ALIASES: Record<string, string> = {
  // path.* namespace
  'path.agentRoot': 'agentRoot',
  'path.agentsRoot': 'agentsRoot',
  'path.projectRoot': 'projectRoot',
  // Legacy / backwards-compatible snake_case names
  agent_name: 'agentName',
  agent_root: 'agentRoot',
  agents_root: 'agentsRoot',
  project_root: 'projectRoot',
  project_id: 'projectId',
  run_mode: 'runMode',
}

function buildVariableMap(context: ContextResolverContext): Record<string, string> {
  const canonical = buildCanonicalVariables(context)
  const variables: Record<string, string> = { ...canonical }
  for (const [alias, target] of Object.entries(VARIABLE_ALIASES)) {
    variables[alias] = canonical[target] ?? ''
  }
  return variables
}

function buildScopeRef(agentId: string, projectId: string, taskId: string): string {
  if (agentId.length === 0) {
    return ''
  }
  let ref = agentId
  if (projectId.length > 0) {
    ref += `@${projectId}`
    if (taskId.length > 0) {
      ref += `:${taskId}`
    }
  }
  return ref
}

function buildHandle(agentId: string, projectId: string, taskId: string, lane: string): string {
  const base = buildScopeRef(agentId, projectId, taskId)
  if (base.length === 0) {
    return ''
  }
  return lane.length > 0 ? `${base}~${lane}` : base
}

function formatLocalDate(now: Date): string {
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getAgentNameFromProfile(profile: Record<string, unknown> | undefined): string | undefined {
  if (!isRecord(profile)) {
    return undefined
  }
  const agent = profile['agent']
  if (!isRecord(agent)) {
    return undefined
  }
  return typeof agent['name'] === 'string' ? agent['name'] : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function interpolateVariables(content: string, context: ContextResolverContext): string {
  const variables = buildVariableMap(context)
  const env = context.env ?? process.env

  return content.replace(
    /\{\{\s*([a-zA-Z_][a-zA-Z_0-9.]*)\s*\}\}/g,
    (match, variableName: string) => {
      if (variableName.startsWith(ENV_PREFIX)) {
        const envKey = variableName.slice(ENV_PREFIX.length)
        const envValue = env[envKey]
        return typeof envValue === 'string' ? envValue : ''
      }
      return variableName in variables ? (variables[variableName] ?? '') : match
    }
  )
}
