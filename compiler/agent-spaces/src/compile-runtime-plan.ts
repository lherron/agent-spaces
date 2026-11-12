import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseAgentProfile } from 'spaces-config'
import { pathMarker, pathMarkerTimer } from 'spaces-config/path-markers'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import { compileError, hygieneBlockResponse } from './compile-diagnostics.js'
import { timeCompilePhase, timeCompilePhaseSync } from './compile-phases.js'
import type { CompilePlacement, CompileRuntimePlanOptions } from './compile-plan-types.js'
import { BUILDER_REGISTRY } from './harness-selection/builders.js'
import {
  CompileProvisioningError,
  resolveCompileSources,
} from './harness-selection/compile-provisioning.js'
import { resolveHarnessExecution } from './harness-selection/resolve.js'
import {
  PreparationContextMismatchError,
  assertPreparationTaskContext,
} from './preparation-execution-context.js'

const LAUNCH_REFUSALS = {
  'participant-only': {
    code: 'agent_participant_only',
    why: 'its seat joins HRC as a direct participant and is never launched',
  },
  'self-brokered': {
    code: 'agent_self_brokered',
    why: 'HRC starts its own launch_command, which serves its own broker, and never compiles a bundle for it',
  },
} as const

/**
 * Backstop for a `[placement] launch` that HRC never compiles for: a
 * `participant-only` agent (T-09061) joins HRC as a direct participant, and a
 * `self-brokered` one (T-13435) is started from its own launch_command. No
 * compile may produce a launchable plan for either. HRC refuses before it gets
 * here; this holds even if a SOUL.md is later added to the home. An absent or
 * unparsable profile is left to the normal compile path to report.
 */
function launchRefusal(agentRoot: string): RuntimeCompileResponse | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  let launch: keyof typeof LAUNCH_REFUSALS | undefined
  try {
    launch = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath).placement?.launch
  } catch {
    return undefined
  }
  if (launch === undefined) return undefined
  const { code, why } = LAUNCH_REFUSALS[launch]
  return {
    schemaVersion: 'agent-runtime-compile-response/v2',
    ok: false,
    diagnostics: [
      compileError(
        code,
        `Agent at ${agentRoot} is ${launch} ([placement] launch = "${launch}"): ${why}`,
        { agentRoot, launch }
      ),
    ],
  }
}

/**
 * Compile one runtime request: resolve the harness execution recipe, then hand
 * it to that recipe's builder (see `harness-selection/builders.ts`).
 */
export async function compileRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const marked = pathMarkerTimer('compile.entry')
  try {
    const response = await compileResolvedRuntimePlan(req, options)
    marked(response.ok ? 'ok' : `refused:${response.diagnostics[0]?.code ?? 'unknown'}`)
    return response
  } catch (error) {
    marked('threw')
    throw error
  }
}

async function compileResolvedRuntimePlan(
  req: RuntimeCompileRequest,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  try {
    const placement = req.placement as CompilePlacement
    const refusal = launchRefusal(placement.agentRoot)
    if (refusal !== undefined) return refusal
    // A taskContext naming a different task than the scope states is refused
    // before any builder materializes anything (T-09860).
    assertPreparationTaskContext(placement, req.materialization.taskContext)
    const { provisioningLayers, sessionMetadata, metadataDiagnostics } = resolveCompileSources(req)
    const consistencyAgentIds = [basename(placement.agentRoot)]
    if (placement.bundle.kind === 'agent-project') {
      consistencyAgentIds.push(placement.bundle.agentName)
    }
    const resolved = timeCompilePhaseSync('resolve', () =>
      resolveHarnessExecution({
        agent: req.agent,
        requested: req.requested,
        provisioningLayers,
        consistency: { agentIds: consistencyAgentIds },
      })
    )
    if (!resolved.ok) {
      return {
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [compileError(resolved.code, resolved.message, resolved.details)],
      }
    }
    pathMarker('compile.recipe', resolved.recipe.recipeId)
    pathMarker('compile.harness-source', resolved.selection.provenance.harness)
    pathMarker(
      'compile.continuation',
      req.continuation === undefined ? 'fresh' : `resume:${req.continuation.hrc.provider}`
    )
    const response = await timeCompilePhase('build', () =>
      BUILDER_REGISTRY[resolved.recipe.builder](req, placement, resolved, options)
    )
    return response.ok
      ? {
          ...response,
          sessionMetadata,
          diagnostics: [...response.diagnostics, ...metadataDiagnostics],
        }
      : response
  } catch (error) {
    // Compose-time hygiene gate block — convert the typed error to `ok: false`
    // with `materialization_hygiene_error` diagnostics HERE, at/below the compiler
    // boundary, before the aspc facade's generic catch can degrade it to
    // `compiler_exception` (T-05574 Cond 1). All other errors propagate unchanged.
    if (error instanceof PreparationContextMismatchError) {
      return {
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [compileError(error.code, error.message)],
      }
    }
    if (error instanceof CompileProvisioningError) {
      return {
        schemaVersion: 'agent-runtime-compile-response/v2',
        ok: false,
        diagnostics: [compileError(error.code, error.message, error.details)],
      }
    }
    const blocked = hygieneBlockResponse(error)
    if (blocked !== undefined) {
      return blocked
    }
    throw error
  }
}
