export type CodexApprovalPolicy = 'untrusted' | 'on-failure' | 'on-request' | 'never'
export type CodexSandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access'

export interface CodexSessionConfig {
  ownerId: string
  cwd: string
  sessionId?: string | undefined
  appServerCommand?: string | undefined
  homeDir: string
  templateDir?: string | undefined
  model?: string | undefined
  approvalPolicy?: CodexApprovalPolicy | undefined
  sandboxMode?: CodexSandboxMode | undefined
  resumeThreadId?: string | undefined
  eventsOutputPath?: string | undefined
}

export interface CodexTurnArtifacts {
  diff?: string | undefined
  plan?: {
    explanation: string | null
    plan: Array<{ id?: string | undefined; text?: string | undefined; status?: string | undefined }>
  }
}
