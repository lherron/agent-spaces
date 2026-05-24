import type { InvocationId, PermissionRequestId, TurnId } from 'spaces-harness-broker-protocol'
import type { RequestId, RunId, RuntimeId } from './ids'
import type { IsoTimestamp } from './primitives'

export type BrokerPermissionPolicy =
  | {
      mode: 'deny'
      audit: true
    }
  | {
      mode: 'allow'
      audit: true
      provenance: {
        source: 'user-request' | 'operator-config' | 'test'
        requestId: RequestId
        createdAt: IsoTimestamp
      }
    }
  | {
      mode: 'ask-client'
      timeoutMs: number
      defaultDecision: 'deny' | 'allow'
      surface: 'api' | 'agentchat' | 'both'
      audit: true
    }

export type BrokerPermissionRequestKind = 'command' | 'file_change' | 'tool' | string

export type BrokerPermissionRequest = {
  permissionRequestId: PermissionRequestId
  invocationId: InvocationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  turnId?: TurnId | undefined
  kind: BrokerPermissionRequestKind
  subject: unknown
  defaultDecision: 'allow' | 'deny'
  deadlineMs?: number | undefined
  requestedAt: IsoTimestamp
}

export type BrokerPermissionDecision = {
  permissionRequestId: PermissionRequestId
  decision: 'allow' | 'deny'
  message?: string | undefined
  decidedAt: IsoTimestamp
}

export type BrokerPermissionDecisionRecord = {
  permissionRequestId: PermissionRequestId
  invocationId: InvocationId
  runtimeId: RuntimeId
  runId?: RunId | undefined
  kind: BrokerPermissionRequestKind
  subjectRedactedJson: string
  defaultDecision: 'allow' | 'deny'
  decision: 'allow' | 'deny'
  decidedBy: 'policy' | 'user' | 'api' | 'timeout'
  policy: BrokerPermissionPolicy
  requestedAt: IsoTimestamp
  decidedAt: IsoTimestamp
}

export type BrokerPermissionRuntimeState = {
  policy: BrokerPermissionPolicy
  negotiated: boolean
  pending: BrokerPermissionRequest[]
  lastDecision?: BrokerPermissionDecisionRecord | undefined
}
