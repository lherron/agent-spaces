import type { InvocationId } from 'spaces-harness-broker-protocol'
import type { HostSessionId, RequestId, RunId, RuntimeId, RuntimeOperationId, TraceId } from './ids'

export type RuntimeObservabilityInput = {
  traceId?: TraceId | undefined
  otel?:
    | {
        enabled: boolean
        endpoint?: string | undefined
        headers?: Record<string, string> | undefined
      }
    | undefined
}

export type BrokerObservabilityContract = {
  correlation: {
    requestId: RequestId
    operationId: RuntimeOperationId
    hostSessionId: HostSessionId
    generation: number
    runtimeId: RuntimeId
    runId?: RunId | undefined
    invocationId: InvocationId
    traceId?: TraceId | undefined
  }
  driverConfig?: Record<string, unknown> | undefined
}
