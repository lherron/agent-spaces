import type { InvocationId } from 'spaces-harness-broker-protocol'
import type { ProviderDomain } from './primitives'
import type { IsoTimestamp } from './primitives'

export type HrcContinuationRef = {
  provider: ProviderDomain
  keyHash: string
  key?: string | undefined
}

export type BrokerContinuationRef = {
  provider: string
  kind?: 'thread' | 'session' | 'conversation' | string | undefined
  keyHash: string
  key?: string | undefined
}

export type RuntimeContinuationRef = {
  schemaVersion: 'runtime-continuation/v1'
  hrc: HrcContinuationRef
  broker?: BrokerContinuationRef | undefined
  source: 'embedded-sdk' | 'harness-broker' | 'legacy-exec' | 'terminal-hook'
  sourceEvent?:
    | {
        invocationId?: InvocationId | undefined
        eventSeq?: number | undefined
        eventType?: string | undefined
      }
    | undefined
  observedAt: IsoTimestamp
}
