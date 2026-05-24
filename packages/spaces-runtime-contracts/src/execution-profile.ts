import type {
  InvocationStartRequest,
  RedactedHarnessInvocationSpec,
  RedactedInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { CapabilityRequirements } from './capabilities'
import type { CompileDiagnostic } from './compiler-plan'
import type { BrokerContinuationRef, RuntimeContinuationRef } from './continuation'
import type { AgentchatExposurePolicy } from './exposure'
import type {
  CompatibilityHash,
  ProfileHash,
  ProfileId,
  RedactedSpecHash,
  RedactedStartRequestHash,
  SpecHash,
  StartRequestHash,
} from './ids'
import type { BrokerInputPolicy } from './input'
import type { BrokerObservabilityContract } from './observability'
import type { BrokerPermissionPolicy } from './permissions'
import type { InteractionMode, ProviderDomain, RuntimeExecutionProfileKind } from './primitives'
import type { RuntimeResourceLimits } from './resources'

export type {
  HarnessInvocationSpec,
  InvocationInput,
  InvocationStartRequest,
  RedactedHarnessInvocationSpec,
  RedactedInvocationStartRequest,
} from 'spaces-harness-broker-protocol'

export type RuntimeExecutionProfile =
  | TerminalExecutionProfile
  | EmbeddedSdkExecutionProfile
  | BrokerExecutionProfile
  | CommandExecutionProfile
  | LegacyExecutionProfile

export type RuntimeExecutionProfileBase = {
  schemaVersion: 'agent-runtime-profile/v1'
  profileId: ProfileId
  profileHash: ProfileHash
  compatibilityHash: CompatibilityHash
  kind: RuntimeExecutionProfileKind
  interactionMode: InteractionMode
  expectedCapabilities: CapabilityRequirements
  redactedProfile: unknown
  diagnostics?: CompileDiagnostic[] | undefined
}

export type TerminalExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'terminal'
  interactionMode: 'interactive'
  terminal: {
    host: 'tmux' | 'ghostty'
    startupMethod: 'create-terminal' | 'reuse-existing' | 'adopt-terminal'
    turnDelivery: 'terminal-launch-input' | 'terminal-literal-input'
  }
  process: {
    command: string
    args: string[]
    cwd: string
    env: Record<string, string>
    io: { kind: 'pty'; cols?: number | undefined; rows?: number | undefined }
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
    env: Record<string, string>
  }
  policy: {
    inputPolicy?: BrokerInputPolicy | undefined
    resourceLimits?: RuntimeResourceLimits | undefined
  }
  continuation?: RuntimeContinuationRef | undefined
}

export type BrokerExecutionProfile = RuntimeExecutionProfileBase & {
  kind: 'harness-broker'
  interactionMode: 'headless'

  brokerProtocol: 'harness-broker/0.1'
  brokerDriver: 'codex-app-server' | string
  brokerOwnership: 'hrc-owned-process'

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: SpecHash
    redactedSpecHash: RedactedSpecHash
    startRequestHash: StartRequestHash
    redactedStartRequestHash: RedactedStartRequestHash
    redactedSpec: RedactedHarnessInvocationSpec
    redactedStartRequest: RedactedInvocationStartRequest
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
    env: Record<string, string>
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
