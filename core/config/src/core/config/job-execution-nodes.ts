const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

export type JobExecutionNodesValidation =
  | { ok: true; nodes: string[] }
  | {
      ok: false
      code: 'type' | 'minItems' | 'const' | 'pattern' | 'conflict'
      message: string
    }

/**
 * Normalize authored job execution placement to the canonical ACP owner-set shape.
 *
 * The wildcard is deliberately left unexpanded because ASP has no node registry.
 */
export function normalizeJobExecutionNodes(value: unknown): JobExecutionNodesValidation {
  const authored = typeof value === 'string' ? [value] : value
  if (!Array.isArray(authored) || authored.some((nodeId) => typeof nodeId !== 'string')) {
    return {
      ok: false,
      code: 'type',
      message: 'must be a node id string, an array of node id strings, or "all"',
    }
  }
  if (authored.length === 0) {
    return { ok: false, code: 'minItems', message: 'must contain at least one node id' }
  }

  const nodes = [...new Set(authored)]
  if (nodes.includes('local')) {
    return {
      ok: false,
      code: 'const',
      message: '"local" is not allowed for job execution ownership',
    }
  }
  if (nodes.includes('all') && nodes.length !== 1) {
    return {
      ok: false,
      code: 'conflict',
      message: '"all" cannot be mixed with concrete node ids',
    }
  }
  for (const nodeId of nodes) {
    if (nodeId !== 'all' && !NODE_ID_PATTERN.test(nodeId)) {
      return {
        ok: false,
        code: 'pattern',
        message: `"${nodeId}" must be a node id matching [A-Za-z0-9._-]{1,64}`,
      }
    }
  }

  return { ok: true, nodes: nodes.sort() }
}
