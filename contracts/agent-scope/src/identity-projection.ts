import type { ScopeKind } from './types.js'

/**
 * `identity.project` (conformance/README.md): the one lenient operation.
 * Projects whatever scope string a stored record carries into parts for
 * display and filtering. It validates no token and never throws; a string it
 * cannot place is `unparsed`, carrying the raw string as `agentId`.
 *
 * Defined by hrc-common `legacy_derive_identity` (hrc-runtime
 * crates/hrc-common/src/scope.rs) as it behaved on 2026-11-09. Never use it to
 * accept caller input: CLI arguments, env and RPC parameters go through the
 * strict parsers.
 *
 * Deliberately not exported from the package entry point.
 */
export type ProjectedScopeIdentity =
  | { kind: 'unparsed'; agentId: string }
  | {
      kind: ScopeKind
      agentId: string
      projectId?: string
      taskId?: string
      roleName?: string
    }

export function projectScopeIdentity(scope: string): ProjectedScopeIdentity {
  const parts = scope.split(':')
  const unparsed = { kind: 'unparsed' as const, agentId: scope }
  const [head, agentId, k2, projectId, k4, v5, k6, v7] = parts
  if (head !== 'agent' || agentId === undefined || agentId === '') return unparsed

  if (parts.length === 2) return { kind: 'agent', agentId }
  if (k2 !== 'project' || projectId === undefined) return unparsed
  if (parts.length === 4) return { kind: 'project', agentId, projectId }
  if (parts.length === 6 && k4 === 'role' && v5 !== undefined) {
    return { kind: 'project-role', agentId, projectId, roleName: v5 }
  }
  if (parts.length === 6 && k4 === 'task' && v5 !== undefined) {
    return { kind: 'project-task', agentId, projectId, taskId: v5 }
  }
  if (
    parts.length === 8 &&
    k4 === 'task' &&
    k6 === 'role' &&
    v5 !== undefined &&
    v7 !== undefined
  ) {
    return { kind: 'project-task-role', agentId, projectId, taskId: v5, roleName: v7 }
  }
  return unparsed
}
