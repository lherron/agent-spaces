import type { BrokerCapabilities, InvocationCapabilities } from 'spaces-harness-broker-protocol'
import type { InvocationLifecycleCapabilities } from 'spaces-harness-broker-protocol'
import type { ProfileHash } from './ids'

export type { BrokerCapabilities, InvocationCapabilities } from 'spaces-harness-broker-protocol'
export type { InvocationLifecycleCapabilities } from 'spaces-harness-broker-protocol'

export type CapabilityNeed = 'required' | 'optional' | 'forbidden'

export type CapabilityRequirements = {
  input: {
    user: CapabilityNeed
    steer: CapabilityNeed
    appendContext: CapabilityNeed
    localImages: CapabilityNeed
    fileRefs: CapabilityNeed
    queue: CapabilityNeed
  }
  turns: {
    concurrency: 'single' | 'multiple' | 'any'
    interrupt: CapabilityNeed
  }
  continuation: CapabilityNeed
  permissions: 'none' | 'broker-request' | 'client-mediated'
  events: {
    assistantDeltas: 'required' | 'optional'
    toolCalls: 'required' | 'optional'
    usage: 'required' | 'optional'
    diagnostics: 'required' | 'optional'
  }
  control: {
    stop: CapabilityNeed
    dispose: CapabilityNeed
    reconcile: CapabilityNeed
    attachReplay: CapabilityNeed
  }
  lifecycle: {
    runtimeRetention: Array<'keep-alive' | 'idle-ttl' | 'unmanaged'>
    harnessRecovery: Array<'none' | 'fail-and-escalate' | 'recycle-child'>
    turnRetry: Array<'none' | 'safe-retry'>
    generationFencing: CapabilityNeed
    permissionCancellation: CapabilityNeed
  }
}

export type RuntimeCapabilities = {
  input: {
    user: boolean
    steer: boolean
    appendContext: boolean
    localImages: boolean
    fileRefs: boolean
    queue: boolean
  }
  turns: {
    concurrency: 'single' | 'multiple'
    interrupt: 'unsupported' | 'protocol' | 'process'
  }
  continuation: {
    supported: boolean
    provider?: string | undefined
    keyKind?: string | undefined
  }
  permissions: {
    mode: 'none' | 'broker-request' | 'client-mediated'
    brokerToClientRequests: boolean
  }
  events: {
    assistantDeltas: boolean
    toolCalls: boolean
    usage: boolean
    diagnostics: boolean
    replay: boolean
    ack: boolean
  }
  control: {
    stop: boolean
    dispose: boolean
    interrupt: boolean
    status: boolean
    attach: boolean
  }
  lifecycle: InvocationLifecycleCapabilities
}

export type HrcCapabilityPolicy = {
  allowDegrade: boolean
  allowedDegradations?:
    | Array<{
        path: string
        from: unknown
        to: unknown
        reason: string
      }>
    | undefined
  requireBrokerDefaultForCodexHeadless: boolean
}

export type CapabilityResolution = {
  selectedProfileHash: ProfileHash
  requirements: CapabilityRequirements
  hrcPolicy: HrcCapabilityPolicy
  brokerHello?: BrokerCapabilities | undefined
  invocation?: InvocationCapabilities | undefined
  persistedRuntime?: RuntimeCapabilities | undefined
  result:
    | { status: 'compatible'; effective: RuntimeCapabilities }
    | { status: 'reject'; reason: string; missing: string[] }
    | {
        status: 'degrade'
        reason: string
        effective: RuntimeCapabilities
        degradations: string[]
      }
}
