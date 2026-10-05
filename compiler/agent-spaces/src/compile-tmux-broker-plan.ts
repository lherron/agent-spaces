import type {
  HarnessInvocationSpec,
  HarnessLaunchSpec,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import { validateInvocationSpec } from 'spaces-harness-broker-protocol'
import type { RuntimeCompileRequest, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import {
  brokerCorrelation,
  toBrokerAttachments,
  toProcessLimits,
} from './broker-request-projection.js'
import { requestedDisallowedTools } from './compile-diagnostics.js'
import {
  bundleIdentityAndLockHash,
  finalizePlan,
  hygieneWarningsInput,
} from './compile-plan-finalize.js'
import type {
  CompilePlacement,
  CompileRuntimePlanOptions,
  ResolvedRecipeBuilder,
} from './compile-plan-types.js'
import type { ResolvedHarnessExecution } from './harness-selection/types.js'
import {
  type PreparedPlacementCliRuntime,
  preparePlacementCliRuntime,
} from './prepare-cli-runtime.js'

/**
 * Build the harness-kind-agnostic launch payload for tmux broker routes. The
 * priming is delivered to the harness via launch argv (see the prompt-through-
 * argv tests); this payload carries the same material so the tmux launch wrapper
 * can frame-print the header (system prompt + priming) into the pane before the
 * harness boots. Returns undefined when there is nothing to frame.
 */
function buildTmuxLaunchSpec(prepared: PreparedPlacementCliRuntime): HarnessLaunchSpec | undefined {
  const launch: HarnessLaunchSpec = {
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(prepared.systemPrompt?.mode !== undefined
      ? { systemPromptMode: prepared.systemPrompt.mode }
      : {}),
    ...(prepared.expandedPrompt !== undefined ? { initialPrompt: prepared.expandedPrompt } : {}),
  }
  return Object.keys(launch).length > 0 ? launch : undefined
}

/**
 * Per-driver knobs distinguishing the otherwise-identical interactive tmux
 * broker compilers. claude-code-tmux HONORS disallowedTools (threads it into
 * prepare + the broker policy); muse-cli-tmux does NOT support it and instead
 * surfaces a `disallowed_tools_unsupported` diagnostic.
 */
interface TmuxBrokerDriverConfig {
  driverKind: 'claude-code-tmux' | 'muse-cli-tmux'
  provider: 'anthropic' | 'meta'
  frontend: 'claude-code' | 'muse-cli'
  honorDisallowedTools: boolean
}

const CLAUDE_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'claude-code-tmux',
  provider: 'anthropic',
  frontend: 'claude-code',
  honorDisallowedTools: true,
}

const MUSE_TMUX_DRIVER_CONFIG: TmuxBrokerDriverConfig = {
  driverKind: 'muse-cli-tmux',
  provider: 'meta',
  frontend: 'muse-cli',
  honorDisallowedTools: false,
}

/**
 * Compile an interactive claude-code request to an operator-attachable
 * claude-code-tmux compiled execution. The launch shape (command/args/cwd/
 * lockedEnv/pathPrepend) is sourced from preparePlacementCliRuntime, so the
 * hashed process launch byte-matches the known-good claude launch. The process
 * transport is pty (tmux is the terminal surface/host, NOT a transport); surface
 * allocation is deferred to the driver runtime.
 */
export const compileClaudeTmuxPlan: ResolvedRecipeBuilder = (req, placement, resolved, options) =>
  compileTmuxBrokerPlan(req, placement, resolved, CLAUDE_TMUX_DRIVER_CONFIG, options)

export const compileMuseTmuxPlan: ResolvedRecipeBuilder = (req, placement, resolved, options) =>
  compileTmuxBrokerPlan(req, placement, resolved, MUSE_TMUX_DRIVER_CONFIG, options)

/**
 * Harness-kind-agnostic interactive tmux broker compiler. The tmux routes are
 * byte-identical except for the per-driver knobs in {@link TmuxBrokerDriverConfig},
 * so they delegate here. The spec/profile/plan field shapes are preserved
 * verbatim to keep specHash/profileHash/planHash stable for each driver.
 */
async function compileTmuxBrokerPlan(
  req: RuntimeCompileRequest,
  placement: CompilePlacement,
  resolved: ResolvedHarnessExecution,
  driverConfig: TmuxBrokerDriverConfig,
  options?: CompileRuntimePlanOptions
): Promise<RuntimeCompileResponse> {
  const { driverKind, provider, frontend, honorDisallowedTools } = driverConfig

  const attachments = toBrokerAttachments(req.materialization.attachments)
  // claude-code-tmux honors disallowedTools; muse-cli-tmux does not (it emits a
  // diagnostic instead of threading the field through prepare/policy).
  const disallowedTools = honorDisallowedTools ? requestedDisallowedTools(req) : undefined
  const prepared = await preparePlacementCliRuntime(
    {
      provider,
      frontend,
      interactionMode: 'interactive',
      model: resolved.selection.model,
      ...(resolved.selection.reasoningEffort !== undefined
        ? { modelReasoningEffort: resolved.selection.reasoningEffort }
        : {}),
      ...(req.continuation?.hrc.key !== undefined
        ? {
            continuation: {
              provider,
              key: req.continuation.hrc.key,
            },
          }
        : {}),
      ...(req.materialization.initialPrompt !== undefined
        ? { prompt: req.materialization.initialPrompt }
        : {}),
      ...(req.materialization.omitPriming !== undefined
        ? { omitPriming: req.materialization.omitPriming }
        : {}),
      ...(disallowedTools !== undefined ? { disallowedTools } : {}),
      ...(attachments !== undefined && attachments.length > 0 ? { attachments } : {}),
      ...(placement.env !== undefined ? { env: placement.env } : {}),
      ...(placement.lockedEnv !== undefined ? { lockedEnv: placement.lockedEnv } : {}),
      ...(placement.dispatchEnv !== undefined ? { dispatchEnv: placement.dispatchEnv } : {}),
      materializeCodexRuntimeHome: options?.materializeCodexRuntimeHome,
      ...(req.materialization.taskContext !== undefined
        ? { taskContext: req.materialization.taskContext }
        : {}),
      placement,
    },
    options?.clientAspHome,
    options?.clientRegistryPath,
    options?.clientRuntime
  )

  const limits = toProcessLimits(req.hrcPolicy.resourceLimits)
  const taskId = req.materialization.taskContext?.taskId

  // The muse composer stages a stable CLI home (HOME + XDG_* under the bundle)
  // for `muse exec` spawns. Those keys are ambient-class and forbidden in a
  // hashed lockedEnv — and the muse-cli-tmux driver would ignore them anyway:
  // it mints a per-invocation isolated HOME at birth and stamps it over the
  // launch env itself. Strip them for the muse tmux route only.
  const lockedEnv =
    driverKind === 'muse-cli-tmux'
      ? Object.fromEntries(
          Object.entries(prepared.lockedEnv).filter(
            ([key]) => key !== 'HOME' && key !== 'XDG_CONFIG_HOME' && key !== 'XDG_DATA_HOME'
          )
        )
      : prepared.lockedEnv
  const { bundleIdentity, lockHash } = bundleIdentityAndLockHash(prepared.resolvedBundle)
  // pty is the PROCESS TRANSPORT; tmux is the broker terminal surface/host. The
  // tmux driver carries terminalHost so the validator can assert the surface
  // contract without duplicating launch mechanics outside the spec.
  const launch = buildTmuxLaunchSpec(prepared)
  const spec: HarnessInvocationSpec = {
    specVersion: 'harness-broker.invocation/v1',
    ...(req.identity.invocationId !== undefined ? { invocationId: req.identity.invocationId } : {}),
    ...(taskId !== undefined ? { labels: { task: taskId } } : {}),
    harness: {
      frontend,
      provider,
      driver: driverKind,
    },
    process: {
      command: prepared.commandPath,
      args: prepared.args,
      cwd: prepared.cwd,
      lockedEnv,
      ...(prepared.pathPrepend.length > 0 ? { pathPrepend: prepared.pathPrepend } : {}),
      harnessTransport: { kind: 'pty' },
      ...(limits !== undefined ? { limits } : {}),
    },
    interaction: {
      mode: 'interactive',
      turnConcurrency: 'single',
      // FIFO enables the broker busy-input policy for this interactive profile.
      // The tmux driver applies busy input as attempted_steer immediately, leaving
      // the TUI to steer, queue internally, or surface a later hook-derived turn.
      inputQueue: 'fifo',
    },
    ...(req.continuation?.hrc.key !== undefined
      ? {
          continuation: {
            provider,
            key: req.continuation.hrc.key,
            kind: 'session',
          },
        }
      : {}),
    driver: {
      kind: driverKind,
      terminalHost: 'tmux',
      // Operator HOME is REQUIRED for muse model calls: keychain-bound oauth
      // never leaves the operator HOME, so the muse TUI stalls at device-flow
      // login under an isolated HOME even with auth.json symlinked (same
      // posture as the muse-serve driver spec). Other tmux drivers run with
      // the ambient operator HOME already.
      ...(driverKind === 'muse-cli-tmux' ? { homeMode: 'operator' as const } : {}),
    },
    ...(launch !== undefined ? { launch } : {}),
    correlation: brokerCorrelation(req),
  }
  validateInvocationSpec(spec)
  const startRequest: InvocationStartRequest = { spec }

  return finalizePlan({
    req,
    resolved,
    startRequest,
    lockedEnv,
    preparedWarnings: prepared.warnings,
    ...hygieneWarningsInput(prepared),
    effectiveEnvironmentHash: prepared.preparation.effectiveEnvironmentHash,
    disallowedToolsContext: honorDisallowedTools ? undefined : { selectedDriver: driverKind },
    resolvedBundleSource: prepared.resolvedBundle,
    omitPriming: prepared.omitPriming,
    bundleIdentity,
    placement,
    materializedBundleRoot: prepared.materialized.materialization.outputPath,
    ...(prepared.systemPrompt?.path !== undefined
      ? { systemPromptFile: prepared.systemPrompt.path }
      : {}),
    ...(lockHash !== undefined ? { lockHash } : {}),
    nowIso: options?.compileContext?.nowIso,
    dispatch: options?.dispatch,
  })
}
