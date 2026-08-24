import type { HarnessRunOptions } from './types/harness.js'

export const DEFAULT_CODEX_ENABLED_FEATURES = ['goals'] as const

export interface CodexAppServerLaunchDescriptor {
  prompt?: string | undefined
  resumeThreadId?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  profile?: string | undefined
  imageAttachments?: string[] | undefined
  featureFlags?: string[] | undefined
  extraArgs?: string[] | undefined
}

/** Build the declarative Codex app-server launch shape from harness options. */
export function buildCodexAppServerLaunchDescriptor(
  options: HarnessRunOptions
): CodexAppServerLaunchDescriptor {
  const sandboxMode = options.yolo ? 'danger-full-access' : options.sandboxMode
  return {
    ...(options.prompt !== undefined ? { prompt: options.prompt } : {}),
    ...(typeof options.continuationKey === 'string'
      ? { resumeThreadId: options.continuationKey }
      : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.modelReasoningEffort !== undefined
      ? { modelReasoningEffort: options.modelReasoningEffort }
      : {}),
    approvalPolicy: 'never',
    ...(sandboxMode !== undefined ? { sandboxMode } : {}),
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
    ...(options.imageAttachments !== undefined
      ? { imageAttachments: options.imageAttachments }
      : {}),
    featureFlags: [...(options.featureFlags ?? DEFAULT_CODEX_ENABLED_FEATURES)],
    ...(options.extraArgs !== undefined ? { extraArgs: options.extraArgs } : {}),
  }
}
