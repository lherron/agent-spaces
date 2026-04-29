import type { BuildResult, HarnessId, ResolveOptions } from 'spaces-config'

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
