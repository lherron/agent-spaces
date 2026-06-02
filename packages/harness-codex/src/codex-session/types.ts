import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'node:child_process'

export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export type CodexSandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly'; networkAccess: boolean }
  | {
      type: 'workspaceWrite'
      writableRoots: string[]
      networkAccess: boolean
      excludeTmpdirEnvVar: boolean
      excludeSlashTmp: boolean
    }

export function toCodexSandboxPolicy(
  mode: CodexSandboxMode | undefined
): CodexSandboxPolicy | null {
  switch (mode) {
    case 'danger-full-access':
      return { type: 'dangerFullAccess' }
    case 'read-only':
      return { type: 'readOnly', networkAccess: false }
    case 'workspace-write':
      return {
        type: 'workspaceWrite',
        writableRoots: [],
        networkAccess: false,
        excludeTmpdirEnvVar: false,
        excludeSlashTmp: false,
      }
    default:
      return null
  }
}

/**
 * Factory used to spawn the `codex app-server` child process. Defaults to
 * `node:child_process.spawn`; injectable so the interactive session can be
 * unit-tested against a fake process (mirroring the injected `proc` the
 * one-shot path already accepts).
 */
export type CodexSpawnProc = (
  command: string,
  args: string[],
  options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams

export interface CodexSessionConfig {
  ownerId: string
  cwd: string
  sessionId?: string | undefined
  appServerCommand?: string | undefined
  homeDir: string
  templateDir?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: CodexApprovalPolicy | undefined
  sandboxMode?: CodexSandboxMode | undefined
  profile?: string | undefined
  featureFlags?: string[] | undefined
  extraArgs?: string[] | undefined
  resumeThreadId?: string | undefined
  eventsOutputPath?: string | undefined
  spawnProc?: CodexSpawnProc | undefined
}

export interface CodexTurnArtifacts {
  diff?: string | undefined
  plan?: {
    explanation: string | null
    plan: Array<{ id?: string | undefined; text?: string | undefined; status?: string | undefined }>
  }
}
