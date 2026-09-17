import type { HostCorrelation, RunMode, RunScaffoldPacket, RuntimeBundleRef } from './external.js'
import type { InteractionMode, ProviderDomain } from './primitives.js'

export type HarnessContinuationKey = string
export type HarnessContinuationRef = {
  provider: ProviderDomain
  key?: HarnessContinuationKey | undefined
}
export type ProcessInteractionMode = 'interactive' | 'headless' | 'nonInteractive'
export type ProcessIoMode = 'pty' | 'pipes' | 'inherit'
export type ProcessHarnessFrontend =
  | 'agent-sdk'
  | 'pi-sdk'
  | 'claude-code'
  | 'codex-cli'
  | 'pi-cli'
  | 'muse-cli'
export type IoMode = ProcessIoMode
export type HarnessFrontend = ProcessHarnessFrontend
export interface ProcessRuntimePlacement {
  agentRoot: string
  projectRoot?: string | undefined
  cwd?: string | undefined
  runMode: RunMode
  bundle: RuntimeBundleRef
  scaffoldPackets?: RunScaffoldPacket[] | undefined
  correlation?: HostCorrelation | undefined
  dryRun?: boolean | undefined
}
export interface ProcessResolvedRuntimeBundle {
  bundleIdentity: string
  runMode: RunMode
  cwd: string
  instructions: Array<{ slot: string; ref: string; contentHash: string }>
  spaces: Array<{ ref: string; resolvedKey: string; integrity: string }>
}
export interface ProcessAttachmentRef {
  kind: 'url' | 'file'
  filename?: string | undefined
  url?: string | undefined
  path?: string | undefined
  contentType?: string | undefined
  sizeBytes?: number | undefined
  alt?: string | undefined
}
export type ProcessInvocationSpec = {
  provider: ProviderDomain
  frontend: ProcessHarnessFrontend
  argv: string[]
  cwd: string
  env: Record<string, string>
  interactionMode: InteractionMode
  ioMode: ProcessIoMode
  continuation?: HarnessContinuationRef | undefined
  displayCommand?: string | undefined
  systemPromptFile?: string | undefined
  prompts: {
    system: { content: string; mode?: 'append' | 'replace'; sourcePath?: string } | null
    priming: { content: string } | null
  }
  codexAppServer?:
    | {
        prompt?: string | undefined
        resumeThreadId?: string | undefined
        model?: string | undefined
        modelReasoningEffort?: string | undefined
        approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
        sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
        imageAttachments?: string[] | undefined
        featureFlags?: string[] | undefined
        extraArgs?: string[] | undefined
      }
    | undefined
}
export interface BuildProcessInvocationSpecRequest {
  hostSessionId?: string
  aspHome: string
  spec: { spaces: string[] } | { target: { targetName: string; targetDir: string } }
  provider: ProviderDomain
  frontend: 'claude-code' | 'codex-cli' | 'pi-cli'
  model?: string
  modelReasoningEffort?: string
  interactionMode: 'interactive' | 'headless'
  ioMode: ProcessIoMode
  continuation?: HarnessContinuationRef
  cwd: string
  lockedEnv?: Record<string, string>
  dispatchEnv?: Record<string, string>
  artifactDir?: string
  prompt?: string
  omitPriming?: boolean
  attachments?: ProcessAttachmentRef[]
  yolo?: boolean
  placement?: ProcessRuntimePlacement
}
export interface BuildProcessInvocationSpecResponse {
  spec: ProcessInvocationSpec
  resolvedBundle?: ProcessResolvedRuntimeBundle | undefined
  warnings?: string[] | undefined
}
