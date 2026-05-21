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
  }
  control: {
    stop: boolean
    dispose: boolean
  }
}

export interface BrokerCapabilities {
  multiInvocation: boolean
  transports: Array<'stdio-jsonrpc-ndjson'>
  eventNotifications: true
  brokerToClientRequests: boolean
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
