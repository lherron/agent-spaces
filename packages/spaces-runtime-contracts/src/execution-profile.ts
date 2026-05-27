import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import type { CapabilityRequirements } from './capabilities'
import type { CompileDiagnostic } from './compiler-plan'
import type { BrokerContinuationRef, RuntimeContinuationRef } from './continuation'
import type { AgentchatExposurePolicy, BrokerTerminalSurface } from './exposure'
import type { CompatibilityHash, ProfileHash, ProfileId, SpecHash, StartRequestHash } from './ids'
import type { BrokerInputPolicy } from './input'
import type { BrokerObservabilityContract } from './observability'
import type { BrokerPermissionPolicy } from './permissions'
import type { InteractionMode, ProviderDomain, RuntimeExecutionProfileKind } from './primitives'
import type { RuntimeResourceLimits } from './resources'

export type {
  HarnessInvocationSpec,
  InvocationDispatchRequest,
  InvocationInput,
  InvocationStartRequest,
} from 'spaces-harness-broker-protocol'

export type RuntimeExecutionProfile =
  | TerminalExecutionProfile
  | EmbeddedSdkExecutionProfile
  | BrokerExecutionProfile
  | CommandExecutionProfile
  | LegacyExecutionProfile

export type ForegroundTerminalHost = 'foreground'
export type TmuxTerminalHost = 'tmux'
export type GhosttyTerminalHost = 'ghostty'
export type TerminalHost = ForegroundTerminalHost | TmuxTerminalHost | GhosttyTerminalHost
export type ControllerOwnedTerminalHost = TmuxTerminalHost | GhosttyTerminalHost

export type RuntimeExecutionProfileBase = {
  schemaVersion: 'agent-runtime-profile/v1'
  profileId: ProfileId
  profileHash: ProfileHash
  compatibilityHash: CompatibilityHash
  kind: RuntimeExecutionProfileKind
  interactionMode: InteractionMode
  expectedCapabilities: CapabilityRequirements
  diagnostics?: CompileDiagnostic[] | undefined
}

export type TerminalExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'terminal'
  interactionMode: 'interactive'
  terminal: {
    host: TerminalHost
    startupMethod:
      | 'create-terminal'
      | 'reuse-existing'
      | 'adopt-terminal'
      | 'inherit-current-terminal'
    turnDelivery: 'terminal-launch-input' | 'terminal-literal-input'
  }
  process: {
    command: string
    args: string[]
    cwd: string
    lockedEnv: Record<string, string>
    /**
     * Ordered directories prepended to the FINAL composed PATH (platform
     * delimiter, array order). Mutates the reserved PATH key; PATH stays out of
     * lockedEnv. Part of launch shape — included in profile hash material.
     */
    pathPrepend?: string[] | undefined
    io: { kind: 'inherit' } | { kind: 'pty'; cols?: number | undefined; rows?: number | undefined }
  }
  policy: {
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
  }
}

export type EmbeddedSdkExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'embedded-sdk'
  interactionMode: 'nonInteractive'
  sdk: {
    runtime: 'claude-agent-sdk' | 'pi-sdk'
    startupMethod: 'create-sdk-session' | 'reuse-existing'
    turnDelivery: 'sdk-turn' | 'sdk-inflight-input'
  }
  session: {
    provider: ProviderDomain
    modelId: string
    cwd: string
    lockedEnv: Record<string, string>
    /**
     * Ordered directories prepended to the FINAL composed PATH (platform
     * delimiter, array order). Mirrored for parity: an SDK session consumes
     * env the same way a launched harness process does. PATH stays out of
     * lockedEnv. Part of launch shape — included in profile hash material.
     */
    pathPrepend?: string[] | undefined
  }
  policy: {
    inputPolicy?: BrokerInputPolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }
  continuation?: RuntimeContinuationRef | undefined
}

export type BrokerExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'harness-broker'
  interactionMode: 'headless' | 'interactive'

  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: 'codex-app-server' | 'claude-code-tmux' | string
  brokerOwnership: 'hrc-owned-process'
  brokerTerminal?: BrokerTerminalSurface | undefined

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: SpecHash
    startRequestHash: StartRequestHash
    initialInputHash?: string | undefined
  }

  policy: {
    permissionPolicy: BrokerPermissionPolicy
    inputPolicy: BrokerInputPolicy
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
  }

  continuation?:
    | {
        hrc?: RuntimeContinuationRef | undefined
        broker?: BrokerContinuationRef | undefined
      }
    | undefined

  observability: BrokerObservabilityContract
}

export type CommandExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'command-process'
  interactionMode: 'headless' | 'nonInteractive'
  command: {
    startupMethod: 'create-command-process' | 'reuse-existing'
    turnDelivery: 'process-stdin' | 'none'
    argv: string[]
    cwd: string
    lockedEnv: Record<string, string>
    /**
     * Ordered directories prepended to the FINAL composed PATH (platform
     * delimiter, array order). Mutates the reserved PATH key; PATH stays out of
     * lockedEnv. Part of launch shape — included in profile hash material.
     */
    pathPrepend?: string[] | undefined
    shell?:
      | {
          executable?: string | undefined
          login?: boolean | undefined
          interactive?: boolean | undefined
        }
      | undefined
  }
  policy: {
    resourceLimits?: RuntimeResourceLimits | undefined
    exposurePolicy?: AgentchatExposurePolicy | undefined
  }
}

export type LegacyExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'legacy-exec'
  interactionMode: 'headless'
  migrationOnly: true
  removalGate: 'delete-after-broker-codex-cutover'
  legacy: {
    startupMethod: 'legacy-launch-artifact'
    turnDelivery: 'legacy-launch-input'
    launchArtifactShape: 'hrc-launch-artifact/v1'
  }
}
