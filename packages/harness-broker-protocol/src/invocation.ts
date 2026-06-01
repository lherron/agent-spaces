import type { ClientCapabilities, InvocationCapabilities } from './capabilities'
import type { InvocationInputResponse, InvocationState, PermissionRequestParams } from './commands'
import type { ContinuationUpdate, InvocationEventEnvelope } from './events'
import type { InputId, InvocationId, PermissionRequestId, TurnId } from './ids'

export type BrokerProtocolVersion = 'harness-broker/0.1' | 'harness-broker/0.2'

export const SUPPORTED_BROKER_PROTOCOL_VERSIONS = [
  'harness-broker/0.1',
  'harness-broker/0.2',
] as const satisfies readonly BrokerProtocolVersion[]

export type BrokerTerminalSurfaceReport = {
  kind: 'tmux-session'
  socketPath: string
  sessionName: string
  windowId?: string | undefined
  windowName?: string | undefined
  paneId?: string | undefined
}

export interface BrokerAttachRequest {
  runtimeId: string
  hostSessionId: string
  generation: number
  invocationId: InvocationId
  startRequestHash: string
  selectedProfileHash: string
  controllerInstanceId: string
  attachToken: string
  lastProjectedSeq?: number | undefined
  clientCapabilities?: ClientCapabilities | undefined
}

export interface BrokerAttachResponse {
  attached: true
  brokerInstanceId: string
  runtimeId: string
  generation: number
  invocationId: InvocationId
  activeControllerInstanceId: string
  currentSeq: number
  retentionFloorSeq: number
  snapshot: InvocationSnapshot
}

export interface InvocationSnapshotRequest {
  invocationId: InvocationId
}

export interface InvocationSnapshot {
  invocationId: InvocationId
  state: InvocationState
  currentTurnId?: TurnId | undefined
  continuation?: ContinuationUpdate | undefined
  capabilities: InvocationCapabilities
  pendingInputIds: InputId[]
  inputDispositions: Record<string, InvocationInputResponse>
  pendingPermissionRequests: PermissionRequestParams[]
  terminalSurface?: BrokerTerminalSurfaceReport | undefined
  process?:
    | {
        brokerPid?: number | undefined
        childPid?: number | undefined
        exitCode?: number | null | undefined
        signal?: string | null | undefined
      }
    | undefined
  currentSeq: number
  retentionFloorSeq: number
}

export interface InvocationEventsSinceRequest {
  invocationId: InvocationId
  afterSeq: number
  live?: boolean | undefined
}

export interface InvocationEventsSinceResponse {
  events: InvocationEventEnvelope[]
  currentSeq: number
  retentionFloorSeq: number
  liveStreamAttached?: boolean | undefined
}

export interface InvocationAckEventsRequest {
  invocationId: InvocationId
  throughSeq: number
  controllerInstanceId: string
}

export interface InvocationAckEventsResponse {
  ackedThroughSeq: number
}

export interface InvocationPermissionRespondRequest {
  invocationId: InvocationId
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  message?: string | undefined
  controllerInstanceId?: string | undefined
}

export type InvocationPermissionRespondResponse =
  | {
      status: 'accepted'
      permissionRequestId: PermissionRequestId
      decision: 'allow' | 'deny'
    }
  | {
      status: 'duplicate'
      permissionRequestId: PermissionRequestId
      originalDecision: 'allow' | 'deny'
    }
  | {
      status: 'conflict'
      permissionRequestId: PermissionRequestId
      originalDecision: 'allow' | 'deny'
      attemptedDecision: 'allow' | 'deny'
    }
  | {
      status: 'expired' | 'unknown'
      permissionRequestId: PermissionRequestId
    }

export interface HarnessInvocationSpec {
  specVersion: 'harness-broker.invocation/v1'
  invocationId?: InvocationId | undefined
  labels?: Record<string, string> | undefined
  harness: HarnessDescriptor
  process: HarnessProcessSpec
  interaction?: InteractionSpec | undefined
  continuation?: ContinuationSpec | undefined
  driver: CodexAppServerDriverSpec | UnknownDriverSpec
  /**
   * Harness-kind-agnostic startup payload consumed by launch wrappers BEFORE the
   * harness TUI/protocol is ready: the material needed to frame-print the launch
   * header (system prompt + priming) into the terminal surface. Distinct from
   * `process` (pure exec shape) and from broker `InvocationInput` (subsequent
   * turns). Part of the deterministic launch contract — included in spec hashing.
   */
  launch?: HarnessLaunchSpec | undefined
  correlation?: Record<string, string> | undefined
}

export interface HarnessLaunchSpec {
  /** Path to the materialized system-prompt file (content read at launch for the header). */
  systemPromptFile?: string | undefined
  /** How the harness applies the system prompt; rides with systemPromptFile so the header labels it correctly. */
  systemPromptMode?: 'append' | 'replace' | undefined
  /**
   * Startup priming text. This is launch/header material, NOT broker
   * InvocationInput — the harness receives the priming via its launch argv, and
   * the launch wrapper uses this only to frame-print the priming section.
   */
  initialPrompt?: string | undefined
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
  /**
   * Ordered directory list prepended to the FINAL composed PATH, in array
   * order, using the platform delimiter. Applied AFTER the four-channel
   * disjoint-union env compose. PATH stays ambient/reserved and is forbidden in
   * lockedEnv/dispatchEnv; pathPrepend is the controlled reserved-key mutation.
   * Part of launch shape — included in all process-launch hash material.
   */
  pathPrepend?: string[] | undefined
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
