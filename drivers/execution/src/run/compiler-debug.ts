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

// Internal legacy seam (EN-15986): the pre-cutover routing catalog, frozen
// for old v1 consumers. T-08702 deletes it with the last v1 consumer.
import {
  type HarnessId as LegacyHarnessId,
  getHarnessCatalogEntry,
} from 'spaces-config/internal/legacy-harness'
import type { CompileRuntimeFn, LaunchShape, RunCompileOutcome } from './types.js'
import type { RunCompilerDebugContext } from './types.js'

function harnessFamilyForHarness(
  harnessId: string
): RunCompilerDebugContext['requested']['harnessFamily'] {
  if (harnessId === 'codex') return 'codex'
  if (harnessId === 'pi') return 'pi'
  if (harnessId === 'muse') return 'muse'
  return 'claude-code'
}

function harnessRuntimeForHarness(
  harnessId: string
): RunCompilerDebugContext['requested']['preferredHarnessRuntime'] {
  switch (harnessId) {
    case 'codex':
      return 'codex-cli'
    case 'pi':
      return 'pi-cli'
    case 'muse':
      return 'muse-cli'
    default:
      return 'claude-code-cli'
  }
}

function compileInteractionMode(
  interactive: boolean | undefined
): RunCompilerDebugContext['requested']['interactionMode'] {
  if (interactive !== false) return 'interactive'
  return 'headless'
}

export interface BuildCompilerDebugContextArgs {
  aspHome: string
  registryPath?: string | undefined
  // String (not closed HarnessId): the debug context still addresses legacy
  // adapters on the v1 path; T-08702 removes this with the v1 flow.
  harnessId: string
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

function buildCompilerDebugContext(args: BuildCompilerDebugContextArgs): RunCompilerDebugContext {
  // The v1 debug context still addresses registered adapters (all in the
  // legacy union); the cast carries the runtime string without translating
  // it. T-08702 deletes this with the v1 flow.
  const harnessCatalog = getHarnessCatalogEntry(args.harnessId as LegacyHarnessId)
  return {
    aspHome: args.aspHome,
    registryPath: args.registryPath,
    placement: args.placement,
    requested: {
      modelProvider: harnessCatalog.provider,
      model: args.model,
      reasoningEffort: args.reasoningEffort,
      harnessFamily: harnessFamilyForHarness(args.harnessId),
      preferredHarnessRuntime: harnessRuntimeForHarness(args.harnessId),
      interactionMode: compileInteractionMode(args.interactive),
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
