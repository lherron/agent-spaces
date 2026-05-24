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

export interface RunOptions extends ResolveOptions {
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
  refresh?: boolean | undefined
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
  projectId?: string | undefined
  taskId?: string | undefined
}

export interface RunInvocationResult {
  exitCode: number
  stdout: string
  stderr: string
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
  compilerDebugContext?: RunCompilerDebugContext | undefined
}

export interface GlobalRunOptions {
  aspHome?: string | undefined
  registryPath?: string | undefined
  harness?: HarnessId | undefined
  cwd?: string | undefined
  interactive?: boolean | undefined
  prompt?: string | undefined
  extraArgs?: string[] | undefined
  cleanup?: boolean | undefined
  env?: Record<string, string> | undefined
  dryRun?: boolean | undefined
  settingSources?: string | null | undefined
  permissionMode?: string | undefined
  settings?: string | undefined
  refresh?: boolean | undefined
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
