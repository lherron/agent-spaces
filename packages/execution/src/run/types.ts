import type { BuildResult, HarnessId, ResolveOptions } from 'spaces-config'

export interface RunCompilerDebugContext {
  aspHome: string
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

/**
 * Launch fields shared by both run paths (project-target `RunOptions` and
 * `GlobalRunOptions`). Extracted so a new run option only has to be declared
 * once; the two run modes then differ only in their resolve-time / lifecycle
 * deltas (`projectId`/`taskId`/`refresh` vs `cleanup`/`registryPath`). Keeping
 * these in lockstep is what lets `toHarnessRunOptions` map either bag with a
 * single helper instead of two copy-pasted literals.
 */
export interface BaseRunOptions {
  harness?: HarnessId | undefined
  cwd?: string | undefined
  interactive?: boolean | undefined
  prompt?: string | undefined
  extraArgs?: string[] | undefined
  env?: Record<string, string> | undefined
  dryRun?: boolean | undefined
  settingSources?: string | null | undefined
  permissionMode?: string | undefined
  settings?: string | undefined
  yolo?: boolean | undefined
  debug?: boolean | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  inheritProject?: boolean | undefined
  inheritUser?: boolean | undefined
  artifactDir?: string | undefined
  continuationKey?: string | boolean | undefined
  remoteControl?: boolean | undefined
  sessionNamePrefix?: string | undefined
  pagePrompts?: boolean | undefined
  /**
   * Injected compiler. When provided, the run compiles a real
   * RuntimeCompileRequest (used for `--debug` and, behind the
   * ASP_RUN_VIA_COMPILER gate, to drive a foreground inherit-spawn).
   */
  compileRuntime?: CompileRuntimeFn | undefined
}

export interface RunOptions extends ResolveOptions, BaseRunOptions {
  refresh?: boolean | undefined
  projectId?: string | undefined
  taskId?: string | undefined
}

export interface RunInvocationResult {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * The resolved launch shape (argv + composed env + cwd) for a run.
 *
 * Exposed so the foreground/compiler path and the legacy adapter path can be
 * compared for byte-parity, and so callers can inspect exactly what would be
 * spawned. `env` is the explicit per-launch env (NOT merged with process.env).
 */
export interface LaunchShape {
  command: string
  args: string[]
  cwd?: string | undefined
  env: Record<string, string>
}

/**
 * Result of compiling a run through the asp compiler (compileRuntimePlan),
 * surfaced to the run path via dependency injection (the compiler lives in the
 * `agent-spaces` package, which depends on this one — so the CLI injects it).
 *
 * `request`/`response` are the REAL RuntimeCompileRequest/Response the run used
 * (or would use) — `--debug` dumps these directly with no second compile and no
 * synthetic identities. `foreground` is populated iff the plan produced a
 * foreground TerminalExecutionProfile; when so its launch shape can drive the
 * inherit-spawn instead of the legacy adapter argv path.
 */
export interface RunCompileOutcome {
  ok: boolean
  request: unknown
  response: unknown
  foreground?: LaunchShape | undefined
  diagnostics?: string[] | undefined
}

/** Injected compiler entry point (CLI binds this to createAgentSpacesClient().compileRuntimePlan). */
export type CompileRuntimeFn = (context: RunCompilerDebugContext) => Promise<RunCompileOutcome>

export interface RunResult {
  build: BuildResult
  invocation?: RunInvocationResult | undefined
  exitCode: number
  command?: string | undefined
  displayCommand?: string | undefined
  systemPrompt?: string | undefined
  systemPromptMode?: 'replace' | 'append' | undefined
  reminderContent?: string | undefined
  maxChars?: number | undefined
  promptSectionSizes?: string[] | undefined
  reminderSectionSizes?: string[] | undefined
  totalContextChars?: number | undefined
  nearMaxChars?: boolean | undefined
  primingPrompt?: string | undefined
  compilerDebugContext?: RunCompilerDebugContext | undefined
  launch?: LaunchShape | undefined
  /**
   * The real RuntimeCompileRequest/Response the run compiled (when a compiler
   * was injected). `--debug` dumps these verbatim — no synthetic IDs, no second
   * compile.
   */
  runtimeCompile?: { request: unknown; response: unknown } | undefined
}

export interface GlobalRunOptions extends BaseRunOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
  cleanup?: boolean | undefined
  refresh?: boolean | undefined
}
