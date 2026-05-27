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

import { type HarnessId, getHarnessCatalogEntry } from 'spaces-config'

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
  // `asp run` pi-sdk path would never reach the embedded branch.
  if (harnessId === 'pi-sdk' || harnessId === 'claude-agent-sdk') return 'nonInteractive'
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
