import type {
  BrokerProtocolVersion,
  BrokerTerminalSurfaceReport,
  InvocationCapabilities,
  InvocationId,
  InvocationState,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { RuntimeCapabilities } from './capabilities'
import type { BrokerContinuationRef, RuntimeContinuationRef } from './continuation'
import type { ControllerOwnedTerminalHost } from './execution-profile'
import type {
  CompileId,
  HostSessionId,
  PlanHash,
  ProfileHash,
  ProfileId,
  RunId,
  RuntimeId,
  ServerInstanceId,
  SpecHash,
  StartRequestHash,
} from './ids'
import type { BrokerInputRuntimeState } from './input'
import type { BrokerPermissionRuntimeState } from './permissions'
import type {
  HarnessRuntime,
  IsoTimestamp,
  RuntimeControllerKind,
  RuntimeStateStatus,
} from './primitives'

export type RuntimeState =
  | TerminalRuntimeState
  | EmbeddedSdkRuntimeState
  | BrokerRuntimeState
  | CommandProcessRuntimeState
  | LegacyExecRuntimeState

export type RuntimeStateBase = {
  schemaVersion: 'runtime-state/v1'
  kind: RuntimeControllerKind
  runtimeId: RuntimeId
  hostSessionId: HostSessionId
  generation: number
  status: RuntimeStateStatus
  activeRunId?: RunId | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

export type TerminalRuntimeState = RuntimeStateBase & {
  kind: 'terminal'
  terminal: {
    host: ControllerOwnedTerminalHost
    sessionId?: string | undefined
    windowId?: string | undefined
    paneId?: string | undefined
  }
  capabilities: RuntimeCapabilities
  continuation?: RuntimeContinuationRef | undefined
}

export type EmbeddedSdkRuntimeState = RuntimeStateBase & {
  kind: 'embedded-sdk'
  sdk: {
    runtime: 'claude-agent-sdk' | 'pi-sdk'
    sessionKey?: string | undefined
  }
  capabilities: RuntimeCapabilities
  continuation?: RuntimeContinuationRef | undefined
}

export type BrokerRuntimeEndpoint =
  | { kind: 'stdio-jsonrpc-ndjson' }
  | {
      kind: 'unix-jsonrpc-ndjson'
      socketPath: string
      attachTokenRef: {
        kind: 'file'
        path: string
        redacted: true
      }
    }

export type BrokerRuntimeControlMode = 'broker-ipc' | 'direct-tmux-degraded' | 'stdio-legacy'

export type RuntimeTmuxPaneMetadata = {
  host?: 'tmux' | undefined
  socketPath: string
  sessionName?: string | undefined
  windowId?: string | undefined
  windowName?: string | undefined
  paneId?: string | undefined
}

export type BrokerRuntimeState = RuntimeStateBase & {
  kind: 'harness-broker'

  compile: {
    compileId: CompileId
    planHash: PlanHash
    selectedProfileId: ProfileId
    selectedProfileHash: ProfileHash
    specHash: SpecHash
    startRequestHash: StartRequestHash
  }

  broker: {
    protocolVersion: BrokerProtocolVersion
    brokerPid?: number | undefined
    endpoint: BrokerRuntimeEndpoint
    multiInvocation: boolean
    startedAt: IsoTimestamp
    ownerServerInstanceId: ServerInstanceId
    tmux?: RuntimeTmuxPaneMetadata | undefined
  }

  control?: {
    mode: BrokerRuntimeControlMode
    brokerAttached?: boolean | undefined
    attachedAt?: IsoTimestamp | undefined
    lastAttachError?: string | null | undefined
  }

  invocation: {
    invocationId: InvocationId
    state: InvocationState
    driver: string
    harnessRuntime: HarnessRuntime | string
    childPid?: number | undefined
    currentTurnId?: TurnId | undefined
    lastEventSeq?: number | undefined
    capabilities: InvocationCapabilities
  }

  terminalSurface?:
    | (BrokerTerminalSurfaceReport & {
        reportedAt: IsoTimestamp
      })
    | undefined

  tui?:
    | (RuntimeTmuxPaneMetadata & {
        host: 'tmux'
        operatorAttachTarget?: boolean | undefined
      })
    | undefined
  eventHighWater?: number | undefined

  continuation?: RuntimeContinuationRef | undefined
  brokerContinuation?: BrokerContinuationRef | undefined
  permission: BrokerPermissionRuntimeState
  input: BrokerInputRuntimeState
}

export type CommandProcessRuntimeState = RuntimeStateBase & {
  kind: 'command-process'
  process: {
    pid?: number | undefined
    argv: string[]
    cwd: string
  }
  capabilities: RuntimeCapabilities
}

export type LegacyExecRuntimeState = RuntimeStateBase & {
  kind: 'legacy-exec'
  migrationOnly: true
  launchId?: string | undefined
  wrapperPid?: number | undefined
  childPid?: number | undefined
}
