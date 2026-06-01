import type { InvocationLifecycleCapabilities } from './lifecycle'

export interface InvocationCapabilities {
  input: {
    user: boolean
    steer: boolean
    appendContext: boolean
    localImages: boolean
    fileRefs: boolean
    /**
     * Broker-composed in invocation status/start responses: reflects
     * driverCaps.input.queue && spec.interaction.inputQueue === 'fifo' && driverCaps.input.user.
     * Drivers should set their raw queue-readiness; clients read the composed value.
     */
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
  events: {
    assistantDeltas: boolean
    toolCalls: boolean
    usage: boolean
    diagnostics: boolean
    replay?: boolean | undefined
    ack?: boolean | undefined
  }
  control: {
    stop: boolean
    dispose: boolean
    status?: boolean | undefined
    attach?: boolean | undefined
  }
  permissions?:
    | {
        brokerToClientRequests: boolean
        eventAudit: boolean
      }
    | undefined
  lifecycle: InvocationLifecycleCapabilities
}

export interface BrokerCapabilities {
  multiInvocation: boolean
  transports: Array<'stdio-jsonrpc-ndjson'>
  eventNotifications: true
  brokerToClientRequests: boolean
  attachReplay?: boolean | undefined
}

export interface DriverSummary {
  kind: string
  version: string
  available: boolean
  capabilities?: InvocationCapabilities | undefined
  unavailableReason?: string | undefined
}

export interface ClientCapabilities {
  permissionRequests?: boolean | undefined
  eventAcks?: boolean | undefined
}
