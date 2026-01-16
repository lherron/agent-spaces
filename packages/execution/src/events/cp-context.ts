/**
 * Control-Plane Context Environment Variables
 *
 * WHY: Multi-agent runs need coordination through the control-plane.
 * This module extracts CP context from environment variables and validates
 * them for inclusion in run events. This enables the control-plane to:
 * - Track which WorkItem a run belongs to
 * - Correlate runs across distributed agents
 * - Associate artifacts with specific runs
 * - Enable distributed tracing
 */

/**
 * Control-Plane context extracted from environment variables.
 */
export interface CpContext {
  /** Work item identifier (from CP_WORK_ITEM_ID) */
  workItemId?: string | undefined
  /** Run identifier (from CP_RUN_ID) */
  runId?: string | undefined
  /** Role name (from CP_ROLE) */
  role?: string | undefined
  /** Run kind (from CP_KIND) */
  kind?: string | undefined
  /** Distributed trace identifier (from CP_TRACE_ID) */
  traceId?: string | undefined
}

/** Environment variable names for CP context */
export const CP_ENV_VARS = {
  WORK_ITEM_ID: 'CP_WORK_ITEM_ID',
  RUN_ID: 'CP_RUN_ID',
  ROLE: 'CP_ROLE',
  KIND: 'CP_KIND',
  TRACE_ID: 'CP_TRACE_ID',
} as const

/**
 * Extract CP context from environment variables.
 *
 * @param env - Environment to read from (defaults to process.env)
 * @returns Extracted CP context with only defined values
 */
export function extractCpContext(env: Record<string, string | undefined> = process.env): CpContext {
  const context: CpContext = {}

  const workItemId = env[CP_ENV_VARS.WORK_ITEM_ID]
  if (workItemId) context.workItemId = workItemId

  const runId = env[CP_ENV_VARS.RUN_ID]
  if (runId) context.runId = runId

  const role = env[CP_ENV_VARS.ROLE]
  if (role) context.role = role

  const kind = env[CP_ENV_VARS.KIND]
  if (kind) context.kind = kind

  const traceId = env[CP_ENV_VARS.TRACE_ID]
  if (traceId) context.traceId = traceId

  return context
}

/**
 * Check if CP context has any values set.
 */
export function hasCpContext(context: CpContext): boolean {
  return !!(context.workItemId || context.runId || context.role || context.kind || context.traceId)
}

/**
 * Convert CP context to environment variables object.
 *
 * @param context - CP context to convert
 * @returns Environment variables object suitable for passing to child processes
 */
export function cpContextToEnv(context: CpContext): Record<string, string> {
  const env: Record<string, string> = {}

  if (context.workItemId) env[CP_ENV_VARS.WORK_ITEM_ID] = context.workItemId
  if (context.runId) env[CP_ENV_VARS.RUN_ID] = context.runId
  if (context.role) env[CP_ENV_VARS.ROLE] = context.role
  if (context.kind) env[CP_ENV_VARS.KIND] = context.kind
  if (context.traceId) env[CP_ENV_VARS.TRACE_ID] = context.traceId

  return env
}

/**
 * Merge CP context with existing environment variables.
 *
 * @param baseEnv - Base environment (e.g., process.env or custom env)
 * @param context - CP context to merge
 * @returns New environment with CP context merged in
 */
export function mergeCpContextEnv(
  baseEnv: Record<string, string | undefined>,
  context: CpContext
): Record<string, string> {
  const result: Record<string, string> = {}

  // Copy existing string values
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined) {
      result[key] = value
    }
  }

  // Merge CP context
  return { ...result, ...cpContextToEnv(context) }
}
