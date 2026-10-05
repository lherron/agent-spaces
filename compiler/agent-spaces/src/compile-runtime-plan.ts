import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'

import { parseAgentProfile } from 'spaces-config'
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

// Launch-timing instrumentation (diagnostic). The compiler has no logger of its
// own and runs in-process: client-side for `hrc run --dry-run` previews (lands on
// CLI stderr) and server-side inside hrc-server for real runs (lands in
// hrc-server.err.log). A single line per compile is emitted to stderr so the
// compile cost is observable on both paths. Always-on: this is the launch path,
// not a per-token hot loop.
function emitAspCompileTiming(req: RuntimeCompileRequest, startedAtMs: number): void {
  const durMs = (performance.now() - startedAtMs).toFixed(1)
  process.stderr.write(
    `[asp-timing] compileRuntimePlan dur=${durMs}ms harness=${req.requested.harness ?? '(default)'} presentation=${String(req.requested.presentation ?? false)}\n`
  )
}

/**
 * Backstop for `[placement] launch = "participant-only"` (T-09061): such an
 * agent's seat is hosted outside HRC and joins as a direct participant, so no
 * compile may produce a launchable plan for it. HRC refuses before it gets
 * here; this holds even if a SOUL.md is later added to the home. An absent or
 * unparsable profile is left to the normal compile path to report.
 */
function participantOnlyRefusal(agentRoot: string): RuntimeCompileResponse | undefined {
  const profilePath = join(agentRoot, 'agent-profile.toml')
  let launch: string | undefined
  try {
    launch = parseAgentProfile(readFileSync(profilePath, 'utf8'), profilePath).placement?.launch
  } catch {
    return undefined
  }
  if (launch !== 'participant-only') return undefined
  return {
    schemaVersion: 'agent-runtime-compile-response/v2',
    ok: false,
    diagnostics: [
      compileError(
        'agent_participant_only',
        `Agent at ${agentRoot} is participant-only ([placement] launch = "participant-only"): its seat joins HRC as a direct participant and is never launched`,
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
  const startedAtMs = performance.now()
  try {
    const placement = req.placement as CompilePlacement
    const refusal = participantOnlyRefusal(placement.agentRoot)
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
  } finally {
    emitAspCompileTiming(req, startedAtMs)
  }
}
