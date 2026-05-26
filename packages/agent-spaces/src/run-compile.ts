/**
 * Bridge between `asp run` and the asp compiler (compileRuntimePlan).
 *
 * The compiler lives in this package, which depends on `spaces-execution` — so
 * execution cannot import it directly. The run path takes this function as an
 * injected dependency (RunOptions.compileRuntime); the CLI binds it.
 *
 * It builds the REAL RuntimeCompileRequest the run uses (a freshly allocated,
 * non-synthetic identity), compiles it ONCE, and returns the request/response
 * (for `--debug`) plus the foreground launch shape (for the gated inherit-spawn).
 * There is NO second compile and NO `asp_run_debug_*` identity seeding.
 */

import { randomUUID } from 'node:crypto'

import type { CompileRuntimeFn, RunCompilerDebugContext } from 'spaces-execution'
import {
  DEFAULT_CODEX_BROKER_INPUT_POLICY,
  type RuntimeCompileRequest,
  type RuntimeIdentityAllocation,
} from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from './client.js'
import { foregroundLaunchFromResponse } from './foreground-launch.js'

function rid(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

/** Allocate a real (non-synthetic) identity for an `asp run` compile. */
function allocateRunIdentity(): RuntimeIdentityAllocation {
  return {
    requestId: rid('request') as RuntimeIdentityAllocation['requestId'],
    operationId: rid('runtimeOperation') as RuntimeIdentityAllocation['operationId'],
    hostSessionId: rid('hostSession') as RuntimeIdentityAllocation['hostSessionId'],
    generation: 1,
    runtimeId: rid('runtime') as RuntimeIdentityAllocation['runtimeId'],
    invocationId: rid('inv') as RuntimeIdentityAllocation['invocationId'],
    initialInputId: rid('input') as RuntimeIdentityAllocation['initialInputId'],
    runId: rid('run') as RuntimeIdentityAllocation['runId'],
    traceId: rid('trace') as RuntimeIdentityAllocation['traceId'],
    idempotencyKey: `asp-run:${randomUUID()}`,
  }
}

function normalizeReasoningEffort(
  value: string | undefined
): RuntimeCompileRequest['requested']['reasoningEffort'] {
  if (value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh') {
    return value
  }
  return undefined
}

/** Build the real RuntimeCompileRequest from the run's compiler context. */
function buildRunCompileRequest(context: RunCompilerDebugContext): RuntimeCompileRequest {
  const identity = allocateRunIdentity()
  const now = new Date().toISOString()
  const placement = {
    ...context.placement,
    correlation: {
      ...(typeof context.placement['correlation'] === 'object' &&
      context.placement['correlation'] !== null
        ? (context.placement['correlation'] as Record<string, unknown>)
        : {}),
      sessionRef: {
        scopeRef: context.correlation.scopeRef ?? context.correlation.appSessionKey,
        laneRef: context.correlation.laneRef ?? 'main',
      },
      hostSessionId: identity.hostSessionId,
    },
  }

  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement: placement as RuntimeCompileRequest['placement'],
    requested: {
      modelProvider: context.requested.modelProvider,
      model: context.requested.model,
      reasoningEffort: normalizeReasoningEffort(context.requested.reasoningEffort),
      harnessFamily: context.requested.harnessFamily,
      preferredHarnessRuntime: context.requested.preferredHarnessRuntime,
      interactionMode: context.requested.interactionMode,
    },
    materialization: {
      initialPrompt: context.materialization.initialPrompt,
      resolvedBundleHint: context.materialization
        .resolvedBundleHint as RuntimeCompileRequest['materialization']['resolvedBundleHint'],
    },
    hrcPolicy: {
      permissionPolicy:
        context.hrcPolicy.yolo === true
          ? {
              mode: 'allow',
              audit: true,
              provenance: {
                source: 'operator-config',
                requestId: identity.requestId,
                createdAt: now,
              },
            }
          : { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 120_000, turnTimeoutMs: 120_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces',
      appSessionKey: context.correlation.appSessionKey,
      scopeRef: context.correlation.scopeRef,
      laneRef: context.correlation.laneRef ?? 'main',
    },
  }
}

/**
 * Create the compiler entry point injected into `run()`. Compiles the real
 * request once and returns request/response (for `--debug`) plus the foreground
 * launch shape (for the gated inherit-spawn).
 */
export function createCompileRuntimeFn(aspHome?: string | undefined): CompileRuntimeFn {
  return async (context) => {
    const request = buildRunCompileRequest(context)
    const client = createAgentSpacesClient(aspHome !== undefined ? { aspHome } : {})
    const response = await client.compileRuntimePlan(request)
    const foreground = foregroundLaunchFromResponse(response)
    return {
      ok: response.ok,
      request,
      response,
      ...(foreground ? { foreground } : {}),
      ...(response.ok
        ? {}
        : { diagnostics: response.diagnostics.map((d) => `${d.code}: ${d.message}`) }),
    }
  }
}
