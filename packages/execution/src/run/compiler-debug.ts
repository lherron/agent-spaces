/**
 * Shared assembly for the `--dry-run --debug` compiler debug context.
 *
 * Both project-target runs (run.ts) and space runs (run/space-launch.ts) emit a
 * RunCompilerDebugContext that is identical in its `requested` / `hrcPolicy`
 * portions and in the three harness-id normalizers below. Only the `placement`,
 * `materialization` (initial prompt + resolved bundle hint) and `correlation`
 * portions differ by run mode, so callers pass those in.
 *
 * Behavior-preserving consolidation of two byte-identical copies; do not change
 * the emitted shape.
 */

import { type HarnessId, getHarnessCatalogEntry, isHarnessId } from 'spaces-config'

import type { CompileRuntimeFn, LaunchShape, RunCompileOutcome } from './types.js'
import type { RunCompilerDebugContext } from './types.js'

export function harnessFamilyForHarness(
  harnessId: string
): RunCompilerDebugContext['requested']['harnessFamily'] {
  if (harnessId === 'codex') return 'codex'
  if (harnessId === 'pi' || harnessId === 'pi-sdk') return 'pi'
  return 'claude-code'
}

export function harnessRuntimeForHarness(
  harnessId: string
): RunCompilerDebugContext['requested']['preferredHarnessRuntime'] {
  switch (harnessId) {
    case 'claude-agent-sdk':
      return 'claude-agent-sdk'
    case 'codex':
      return 'codex-cli'
    case 'pi':
      return 'pi-cli'
    case 'pi-sdk':
      return 'pi-sdk'
    default:
      return 'claude-code-cli'
  }
}

export function compileInteractionMode(
  interactive: boolean | undefined,
  harnessId?: string
): RunCompilerDebugContext['requested']['interactionMode'] {
  if (interactive !== false) return 'interactive'
  // Embedded-SDK runtimes (pi-sdk, claude-agent-sdk) run their turns IN-PROCESS,
  // so a `--no-interactive` run compiles to the nonInteractive interaction mode
  // that routes to the embedded-sdk controller — NOT the headless broker mode
  // used by the spawned codex app-server. Without this distinction the real
  // `asp run` pi-sdk path would never reach the embedded branch. The set of
  // embedded runtimes is exactly the catalog's `transport: 'sdk'` harnesses.
  if (harnessId !== undefined && isHarnessId(harnessId)) {
    if (getHarnessCatalogEntry(harnessId).transport === 'sdk') return 'nonInteractive'
  }
  return 'headless'
}

export interface BuildCompilerDebugContextArgs {
  aspHome: string
  harnessId: HarnessId
  model?: string | undefined
  reasoningEffort?: string | undefined
  interactive?: boolean | undefined
  yolo?: boolean | undefined
  placement: RunCompilerDebugContext['placement']
  initialPrompt?: string | undefined
  resolvedBundleHint: RunCompilerDebugContext['materialization']['resolvedBundleHint']
  correlation: RunCompilerDebugContext['correlation']
}

export interface MaybeCompileForRunArgs {
  compileRuntime: CompileRuntimeFn | undefined
  /** Whether the foreground spawn should be driven from the compiled plan (ASP_RUN_VIA_COMPILER). */
  viaCompiler: boolean
  /** Whether a `--dry-run --debug` plan dump is requested. */
  wantDebugDump: boolean
  /**
   * Lazily build the run-mode-specific compiler debug context. Only invoked when
   * the gate is open, so callers that never compile pay nothing.
   */
  buildContext: () => BuildCompilerDebugContextArgs
}

export interface MaybeCompileForRunResult {
  compileOutcome?: RunCompileOutcome | undefined
  compiledLaunch?: LaunchShape | undefined
}

/**
 * Shared compiler gate for both run modes (project-target and space).
 *
 * Consolidates the previously copy-pasted `viaCompiler/wantDebugDump` gate +
 * `compileRuntime(...)` invoke + `compiledLaunch` derivation. Callers differ only
 * in how they build the placement/correlation context, passed via `buildContext`.
 */
export async function maybeCompileForRun(
  args: MaybeCompileForRunArgs
): Promise<MaybeCompileForRunResult> {
  if (!args.compileRuntime || (!args.viaCompiler && !args.wantDebugDump)) {
    return {}
  }

  const compileOutcome = await args.compileRuntime(buildCompilerDebugContext(args.buildContext()))
  const compiledLaunch =
    args.viaCompiler && compileOutcome.foreground ? compileOutcome.foreground : undefined

  return { compileOutcome, ...(compiledLaunch ? { compiledLaunch } : {}) }
}

export function buildCompilerDebugContext(
  args: BuildCompilerDebugContextArgs
): RunCompilerDebugContext {
  const harnessCatalog = getHarnessCatalogEntry(args.harnessId)
  return {
    aspHome: args.aspHome,
    placement: args.placement,
    requested: {
      modelProvider: harnessCatalog.provider,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      harnessFamily: harnessFamilyForHarness(args.harnessId),
      preferredHarnessRuntime: harnessRuntimeForHarness(args.harnessId),
      interactionMode: compileInteractionMode(args.interactive, args.harnessId),
    },
    materialization: {
      initialPrompt: args.initialPrompt,
      resolvedBundleHint: args.resolvedBundleHint,
    },
    hrcPolicy: {
      yolo: args.yolo,
    },
    correlation: args.correlation,
  }
}
