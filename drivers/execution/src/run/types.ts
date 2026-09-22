import type { BuildResult, HarnessAdapter, ResolveOptions } from 'spaces-config'
import type { HarnessId } from 'spaces-runtime-contracts'

/**
 * An execution identity resolved by the compiler/catalog before it reaches the
 * driver layer. Drivers consume this concrete adapter and never choose one
 * from a frontend, profile, target, or local default.
 */
export interface ResolvedHarnessAdapter {
  harnessId: HarnessId
  adapter: HarnessAdapter
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
  /** Required compiler/catalog result for the foreground execution path. */
  execution: ResolvedHarnessAdapter
  cwd?: string | undefined
  interactive?: boolean | undefined
  launchSurface?: 'terminal' | 'codex-app' | undefined
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
  launch?: LaunchShape | undefined
}

export interface GlobalRunOptions extends BaseRunOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
  cleanup?: boolean | undefined
  refresh?: boolean | undefined
}
