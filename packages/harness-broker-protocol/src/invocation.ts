import type { InvocationId } from './ids'

export interface HarnessInvocationSpec {
  specVersion: 'harness-broker.invocation/v1'
  invocationId?: InvocationId | undefined
  labels?: Record<string, string> | undefined
  harness: HarnessDescriptor
  process: HarnessProcessSpec
  interaction?: InteractionSpec | undefined
  continuation?: ContinuationSpec | undefined
  driver: CodexAppServerDriverSpec | UnknownDriverSpec
  correlation?: Record<string, string> | undefined
}

export interface HarnessDescriptor {
  frontend: string
  provider?: string | undefined
  driver: 'codex-app-server' | string
}

export interface HarnessProcessSpec {
  command: string
  args: string[]
  cwd: string
  lockedEnv?: Record<string, string> | undefined
  harnessTransport: HarnessTransportSpec
  limits?: ProcessLimits | undefined
}

export type HarnessTransportSpec =
  | { kind: 'jsonrpc-stdio' }
  | { kind: 'pipes' }
  | { kind: 'pty'; cols?: number | undefined; rows?: number | undefined }

export interface InteractionSpec {
  mode: 'headless' | 'interactive' | 'service'
  turnConcurrency?: 'single' | undefined
  inputQueue?: 'none' | 'fifo' | undefined
}

export interface ContinuationSpec {
  provider: string
  key: string
  kind?: 'thread' | 'session' | 'conversation' | string | undefined
}

export interface ProcessLimits {
  startupTimeoutMs?: number | undefined
  turnTimeoutMs?: number | undefined
  stopGraceMs?: number | undefined
  maxEventBytes?: number | undefined
}

export interface CodexAppServerDriverSpec {
  kind: 'codex-app-server'
  resumeThreadId?: string | undefined
  model?: string | undefined
  modelReasoningEffort?: string | undefined
  approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never' | undefined
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' | undefined
  profile?: string | undefined
  defaultImageAttachments?: string[] | undefined
  permissionPolicy?: DriverPermissionPolicy | undefined
  resumeFallback?: 'start-fresh' | 'fail' | undefined
}

export interface DriverPermissionPolicy {
  mode: 'deny' | 'allow' | 'ask-client'
  timeoutMs?: number | undefined
  defaultDecision?: 'allow' | 'deny' | undefined
}

export type PermissionPolicy = DriverPermissionPolicy

export interface UnknownDriverSpec {
  kind: string
  [key: string]: unknown
}
