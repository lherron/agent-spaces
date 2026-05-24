import type {
  InvocationCapabilities,
  InvocationId,
  InvocationState,
  TurnId,
} from 'spaces-harness-broker-protocol'
import type { RuntimeCapabilities } from './capabilities'
import type { BrokerContinuationRef, RuntimeContinuationRef } from './continuation'
import type {
  CompileId,
  HostSessionId,
  PlanHash,
  ProfileHash,
  ProfileId,
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
  RuntimeStatus,
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
  status: RuntimeStatus
  activeRunId?: RunId | undefined
  createdAt: IsoTimestamp
  updatedAt: IsoTimestamp
}

import type { RunId } from './ids'

export type TerminalRuntimeState = RuntimeStateBase & {
  kind: 'terminal'
  terminal: {
    host: 'tmux' | 'ghostty'
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
    protocolVersion: 'harness-broker/0.1'
    brokerPid?: number | undefined
    endpoint: { kind: 'stdio-jsonrpc-ndjson' }
    multiInvocation: boolean
    startedAt: IsoTimestamp
    ownerServerInstanceId: ServerInstanceId
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
