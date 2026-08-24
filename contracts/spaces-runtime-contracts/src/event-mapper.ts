import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { RuntimeControlError } from './errors'
import type {
  HrcEventEnvelope,
  HrcRunRecord,
  HrcRuntimeSnapshot,
  RuntimeOperation,
} from './operations'
import type { BrokerInvocationRecord } from './persistence'
import type { IsoTimestamp } from './primitives'
import type { RuntimeRouteDecision } from './route-decision'

export interface BrokerEventMapper {
  apply(
    event: InvocationEventEnvelope,
    context: BrokerEventContext
  ): Promise<BrokerEventApplyResult>
}

export type BrokerEventContext = {
  runtime: HrcRuntimeSnapshot
  operation?: RuntimeOperation | undefined
  invocation: BrokerInvocationRecord
  routeDecision: RuntimeRouteDecision
  now: IsoTimestamp
  /**
   * Optional cancellation seam for an in-flight event application. Additive and
   * back-compatible: mappers that ignore it behave exactly as before.
   */
  signal?: AbortSignal | undefined
}

export type BrokerEventApplyResult =
  | {
      status: 'applied'
      idempotent: false
      hrcEvents: HrcEventEnvelope[]
      runtimePatch?: Partial<HrcRuntimeSnapshot> | undefined
      runPatch?: Partial<HrcRunRecord> | undefined
    }
  | {
      status: 'duplicate'
      idempotent: true
      existingHrcEventSeq?: number | undefined
    }
  | {
      status: 'ignored'
      reason: string
    }
  | {
      status: 'failed'
      error: RuntimeControlError
    }
