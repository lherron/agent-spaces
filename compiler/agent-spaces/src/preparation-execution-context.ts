/**
 * The one preparation execution context (T-08579; T-08563 rev 5.2).
 *
 * Launch preparation (`preparePlacementCliRuntime`, reached by compile and by
 * direct preparation) and runtime-placement inspection derive prompt identity,
 * prompt-source authority, the template exec/predicate/interpolation
 * environment, and its canonical hash from this module only. `dispatchEnv` is
 * never an input here: it stays launch-process and dispatch input.
 */
import { basename, resolve } from 'node:path'

import { parseScopeRef } from 'agent-scope'

import { type RuntimePlacement, getAspHome } from 'spaces-config'
import type { MaterializeSystemPromptInput, SharedRootOptions } from 'spaces-runtime'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import { deriveHandleParts } from './broker-invocation.js'
import { buildCorrelationEnvVars } from './placement-api.js'

type Environment = Record<string, string | undefined>

export type PreparationIdentityHints = {
  agentId?: string | undefined
  projectId?: string | undefined
  taskId?: string | undefined
}

/**
 * Prompt-source authority for one surface (PROPOSAL §5.3). `sharedRootOptions`
 * absent selects the ambient arm; present, it is the only configuration the
 * project-overlay canonical root is resolved from. Arms are never merged.
 */
export type PreparationPromptSources = {
  aspHome: string
  sharedRootOptions?: SharedRootOptions | undefined
}

export type PreparationIdentity = {
  agentId: string
  projectId?: string | undefined
  taskId?: string | undefined
  lane?: string | undefined
}

export type PreparationExecutionContext = {
  identity: PreparationIdentity
  promptSources: PreparationPromptSources
  execEnv: Record<string, string>
  effectiveEnvironmentHash: string
  promptInput: MaterializeSystemPromptInput
}

export class PreparationContextMismatchError extends Error {
  readonly code = 'configured_context_mismatch' as const
}

const hasher = createCanonicalHasher()

export function hashPreparationEnvironment(env: Record<string, string>): string {
  return hasher.hash(env).value
}

/**
 * Compile arm: an explicit request aspHome anchors discovery exclusively;
 * without one, the ambient arm applies unchanged.
 */
export function promptSourcesForCompile(
  explicitAspHome: string | undefined,
  ambientEnv: Environment = process.env
): PreparationPromptSources {
  if (explicitAspHome === undefined) return { aspHome: getAspHome() }
  const env = sourceEnvironment(ambientEnv, explicitAspHome)
  return { aspHome: explicitAspHome, sharedRootOptions: { aspHome: explicitAspHome, env } }
}

/**
 * Context-surface arm: the declaration's validated, canonical agentSources echo
 * (caller-supplied, or the daemon default when the caller supplied none).
 */
export function promptSourcesForDeclaration(
  echoed: { aspHome?: unknown; agentsRoot?: unknown } | undefined,
  ambientEnv: Environment = process.env
): PreparationPromptSources {
  const aspHome = typeof echoed?.aspHome === 'string' ? echoed.aspHome : getAspHome()
  const agentsRoot = typeof echoed?.agentsRoot === 'string' ? echoed.agentsRoot : undefined
  const env = {
    ...sourceEnvironment(ambientEnv, aspHome),
    ...(agentsRoot !== undefined ? { ASP_AGENTS_ROOT: agentsRoot } : {}),
  }
  return { aspHome, sharedRootOptions: { aspHome, env } }
}

/** Mirrors runtime-declaration's caller source environment. */
function sourceEnvironment(ambientEnv: Environment, aspHome: string): Environment {
  return {
    ...ambientEnv,
    ASP_PROJECT_ROOT_OVERRIDE: undefined,
    ASP_HOME: aspHome,
    ASP_AGENTS_ROOT: undefined,
  }
}

/**
 * Prompt identity (PROPOSAL §4.1). scopeRef facts win; context hints fill only
 * what the scopeRef does not state; a stated conflict is refused.
 */
export function resolvePreparationIdentity(
  placement: RuntimePlacement,
  hints: PreparationIdentityHints = {}
): PreparationIdentity {
  const sessionRef = placement.correlation?.sessionRef
  const parts = deriveHandleParts({ ...placement, projectRoot: undefined })
  // Only a canonical agent ScopeRef states identity facts; a caller-supplied
  // non-agent scope (e.g. `app:`) is preserved literally and never refused.
  if (sessionRef !== undefined && isCanonicalAgentScope(sessionRef.scopeRef)) {
    assertNoConflict('agentId', parts.agentId, hints.agentId)
    assertNoConflict('projectId', parts.projectId, hints.projectId)
    assertNoConflict('taskId', parts.taskId, hints.taskId)
  }
  const agentId =
    sessionRef !== undefined && parts.agentId ? parts.agentId : basename(placement.agentRoot)
  const projectId =
    parts.projectId ??
    hints.projectId ??
    (placement.projectRoot !== undefined ? basename(resolve(placement.projectRoot)) : undefined)
  const taskId = parts.taskId ?? hints.taskId
  return {
    agentId,
    ...(projectId !== undefined ? { projectId } : {}),
    ...(taskId !== undefined ? { taskId } : {}),
    ...(parts.lane !== undefined ? { lane: parts.lane } : {}),
  }
}

function isCanonicalAgentScope(scopeRef: string): boolean {
  try {
    parseScopeRef(scopeRef)
    return true
  } catch {
    return false
  }
}

function assertNoConflict(
  field: string,
  scoped: string | undefined,
  hinted: string | undefined
): void {
  if (scoped !== undefined && hinted !== undefined && scoped !== hinted) {
    throw new PreparationContextMismatchError(
      `sessionRef ${field} ${JSON.stringify(scoped)} conflicts with context ${field} ${JSON.stringify(hinted)}`
    )
  }
}

export function buildPreparationExecutionContext(
  placement: RuntimePlacement,
  inputs: {
    promptSources: PreparationPromptSources
    ambientEnv?: Environment | undefined
    identityHints?: PreparationIdentityHints | undefined
  }
): PreparationExecutionContext {
  const identity = resolvePreparationIdentity(placement, inputs.identityHints)
  const ambientEnv = inputs.ambientEnv ?? process.env
  const execEnv: Environment = {
    ...ambientEnv,
    ...buildCorrelationEnvVars(placement),
    AGENTCHAT_ID: basename(placement.agentRoot),
    ...(identity.projectId !== undefined ? { ASP_PROJECT: identity.projectId } : {}),
  }
  const definedEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(execEnv)) {
    if (value !== undefined) definedEnv[key] = value
  }
  return {
    identity,
    promptSources: inputs.promptSources,
    execEnv: definedEnv,
    effectiveEnvironmentHash: hashPreparationEnvironment(definedEnv),
    promptInput: {
      ...placement,
      aspHome: inputs.promptSources.aspHome,
      ...(inputs.promptSources.sharedRootOptions !== undefined
        ? { sharedRootOptions: inputs.promptSources.sharedRootOptions }
        : {}),
      agentId: identity.agentId,
      ...(identity.projectId !== undefined ? { projectId: identity.projectId } : {}),
      ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
      ...(identity.lane !== undefined ? { lane: identity.lane } : {}),
      env: execEnv,
    },
  }
}

/**
 * The placement a context surface prepares: the declaration's resolved
 * placement with the caller's exact roots, cwd, and preparation correlation.
 */
export function placementFromDeclaration(
  resolvedPlacement: RuntimePlacement,
  context: {
    agentRoot?: string | undefined
    cwd: string
    project: { mode: string; projectRoot?: string | undefined }
  },
  correlation: RuntimePlacement['correlation']
): RuntimePlacement {
  const projectRoot = context.project.mode === 'root' ? context.project.projectRoot : undefined
  return {
    ...resolvedPlacement,
    ...(context.agentRoot ? { agentRoot: context.agentRoot } : {}),
    ...(projectRoot !== undefined ? { projectRoot } : {}),
    ...(resolvedPlacement.bundle.kind === 'agent-project'
      ? {
          bundle: {
            ...resolvedPlacement.bundle,
            ...(projectRoot !== undefined ? { projectRoot } : {}),
          },
        }
      : {}),
    cwd: context.cwd,
    correlation,
  }
}
