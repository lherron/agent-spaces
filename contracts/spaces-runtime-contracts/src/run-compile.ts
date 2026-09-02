/**
 * Compile/run bridge DTOs shared by the execution and compiler planes.
 *
 * These are deliberately behavior-free. The execution plane supplies the
 * implementation and the apps/harness composition plane injects it into the
 * compiler-facing client.
 */

export interface RunCompilerDebugContext {
  aspHome: string
  registryPath?: string | undefined
  placement: Record<string, unknown>
  requested: {
    modelProvider?: 'anthropic' | 'openai' | undefined
    model?: string | undefined
    reasoningEffort?: string | undefined
    harnessFamily?: 'claude-code' | 'codex' | 'pi' | undefined
    preferredHarnessRuntime?:
      | 'claude-code-cli'
      | 'claude-agent-sdk'
      | 'codex-cli'
      | 'pi-cli'
      | 'pi-sdk'
      | undefined
    interactionMode?: 'interactive' | 'headless' | 'nonInteractive' | undefined
  }
  materialization: {
    initialPrompt?: string | undefined
    omitPriming?: boolean | undefined
    resolvedBundleHint?: Record<string, unknown> | undefined
  }
  hrcPolicy: {
    yolo?: boolean | undefined
  }
  correlation: {
    appSessionKey: string
    scopeRef?: string | undefined
    laneRef?: string | undefined
  }
}

export interface RunLaunchShape {
  command: string
  args: string[]
  cwd?: string | undefined
  env: Record<string, string>
}

export interface RunCompileOutcome {
  ok: boolean
  request: unknown
  response: unknown
  foreground?: RunLaunchShape | undefined
  diagnostics?: string[] | undefined
}

export type CompileRuntimeFn = (context: RunCompilerDebugContext) => Promise<RunCompileOutcome>

export type PlacementRuntimeModelResolution =
  | {
      ok: true
      info: {
        effectiveModel: string
        provider: string
        model: string
        explicit: boolean
      }
    }
  | { ok: false; modelId: string }

/**
 * Structural placement-plan contract. Generic parameters keep this bottom-layer
 * DTO independent from the concrete config-plane harness types while preserving
 * their exact types at both callers.
 */
export interface PlacementRuntimePlan<
  TFrontend extends string,
  THarnessId extends string,
  TProvider extends string,
  TRunOptions extends object,
> {
  frontend: TFrontend
  harnessId: THarnessId
  provider: TProvider
  cwd: string
  defaultRunOptions: TRunOptions
  prompt?: string | undefined
  yolo?: boolean | undefined
  model: PlacementRuntimeModelResolution
  runOptions: TRunOptions
}
