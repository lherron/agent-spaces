import type { InvocationLifecycleCapabilities } from './lifecycle'

export type BrokerTransportKind = 'stdio-jsonrpc-ndjson' | 'unix-jsonrpc-ndjson'

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
    snapshot?: boolean | undefined
    eventsSince?: boolean | undefined
    eventTypeFilter?: boolean | undefined
    liveness?: 'none' | 'cached' | 'probe' | undefined
    driverAttachExistingSurface?: boolean | undefined
  }
  permissions?:
    | {
        brokerToClientRequests: boolean
        eventAudit: boolean
      }
    | undefined
  /**
   * Structured final-response support (T-03779). Present only for drivers with
   * a real structured-output path. `jsonSchema`: the driver accepts a per-turn
   * JSON Schema response format. `perTurn`: schemas are scoped to the single
   * turn, not sticky. `strict`: the driver asks upstream for strict schema
   * enforcement (NOT broker-side parsing/validation of the final text).
   * `parsedResult`: the broker emits a parsed object (always false in this
   * pass — broker events remain string-based).
   */
  finalResponse?:
    | {
        jsonSchema: boolean
        perTurn: boolean
        strict: boolean
        parsedResult: boolean
      }
    | undefined
  lifecycle: InvocationLifecycleCapabilities
}

export interface BrokerCapabilities {
  multiInvocation: boolean
  transports: BrokerTransportKind[]
  eventNotifications: true
  brokerToClientRequests: boolean
  attachReplay?: boolean | undefined
  inspection?:
    | {
        listInvocations: boolean
        timestamps: boolean
        lifecycleView: boolean
        liveness: 'none' | 'cached' | 'probe'
        eventTypeFilter: boolean
      }
    | undefined
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
