import type { SecretDigest } from './hash'

export type {
  RedactedHarnessInvocationSpec,
  RedactedInvocationStartRequest,
  RedactedValue,
} from 'spaces-harness-broker-protocol'

export type RedactionState = 'none' | 'redacted' | 'contains-secret-digests'

export type RedactedArtifact<T = unknown> = {
  schemaVersion: string
  redactionState: RedactionState
  hash: string
  value: T
}

export type RedactionDigestCarrier = {
  digest?: SecretDigest | undefined
}
