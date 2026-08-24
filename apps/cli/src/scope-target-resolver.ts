/**
 * Shared scope-handle target resolution for run-like commands.
 *
 * WHY: `asp run` and `asp gui` each parsed an optional `agent@project:task`
 * scope handle with byte-identical try/catch logic. Centralizing it removes
 * the duplication while preserving the exact fallback behavior (any parse
 * failure or missing projectId falls back to treating the target verbatim).
 */

import { parseScopeHandle } from 'agent-scope'

/**
 * A resolved run target derived from a (possibly scope-handle) target string.
 */
export interface ResolvedRunTarget {
  targetName: string
  displayTarget: string
  projectId?: string | undefined
  taskId?: string | undefined
}

/**
 * Resolve a target string that may be a scope handle (`agent@project:task`).
 *
 * Targets without `@`, or that fail to parse, or that carry no projectId, are
 * returned verbatim as both the target name and the display target.
 */
export function resolveRunTarget(target: string): ResolvedRunTarget {
  if (!target.includes('@')) {
    return { targetName: target, displayTarget: target }
  }

  try {
    const parsed = parseScopeHandle(target)
    if (parsed.projectId === undefined) {
      return { targetName: target, displayTarget: target }
    }

    return {
      targetName: parsed.agentId,
      displayTarget: target,
      projectId: parsed.projectId,
      taskId: parsed.taskId,
    }
  } catch {
    return { targetName: target, displayTarget: target }
  }
}
