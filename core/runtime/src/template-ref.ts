/**
 * Resolve a context-template file reference to an absolute path. Scoped refs
 * (`agent-root:///`, `agents-root:///`, `project-root:///`) resolve through the
 * shared root-relative resolver; anything else is interpolated and searched
 * along the overlay-first agent-root search path.
 */
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveRootRelativeRef } from 'spaces-config'
import type { ContextResolverContext } from './context-resolver.js'
import { interpolateVariables } from './template-vars.js'

function isScopedRef(ref: string): boolean {
  return (
    ref.startsWith('agent-root:///') ||
    ref.startsWith('agents-root:///') ||
    ref.startsWith('project-root:///')
  )
}

function resolveScopedRef(ref: string, context: ContextResolverContext): string {
  return resolveRootRelativeRef(ref, {
    agentRoot: context.agentRoot,
    agentsRoot: context.agentsRoot,
    agentRootSearchPath: context.agentRootSearchPath,
    projectRoot: context.projectRoot,
  })
}

function resolveSearchPathRef(ref: string, context: ContextResolverContext): string {
  // Interpolate template variables in file paths (e.g. {{agentRoot}}/memory/MEMORY.md)
  const interpolated = interpolateVariables(ref, context)
  if (interpolated !== ref && isAbsolute(interpolated)) {
    return interpolated
  }

  const roots = context.agentRootSearchPath?.length
    ? context.agentRootSearchPath
    : [context.agentsRoot]
  for (const root of roots) {
    const candidate = join(root, interpolated)
    if (existsSync(candidate)) {
      return candidate
    }
  }
  return join(roots[0] ?? context.agentsRoot, interpolated)
}

export function resolveTemplateRef(ref: string, context: ContextResolverContext): string {
  if (isScopedRef(ref)) {
    return resolveScopedRef(ref, context)
  }
  return resolveSearchPathRef(ref, context)
}
