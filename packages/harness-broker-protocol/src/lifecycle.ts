import { createHash } from 'node:crypto'
import type { InputId, PermissionRequestId, TurnId } from './ids.js'

export type LifecyclePolicyId = string
export type LifecyclePolicyHash = string

export type RuntimeRetentionPolicy =
  | { mode: 'keep-alive' }
  | {
      mode: 'idle-ttl'
      idleTtlMs: number
      retire: {
        mode: 'driver-retire'
        graceMs: number
        onTimeout: 'fail-invocation' | 'escalate-hard-reap'
      }
    }
  | { mode: 'unmanaged'; reason: 'test-only' | string }

export type StallDetectionPolicy =
  | { mode: 'disabled' }
  | {
      mode: 'no-progress-plus-health'
      noProgressMs: number
      minTurnAgeMs?: number | undefined
      healthProbe: 'runner-status' | 'driver-status' | 'native-heartbeat'
    }

export type HarnessRecoveryPolicy =
  | { mode: 'none' }
  | {
      mode: 'fail-and-escalate'
      stallDetection?: StallDetectionPolicy | undefined
      escalation: 'fail-turn' | 'fail-invocation' | 'escalate-hard-reap'
    }
  | {
      mode: 'recycle-child'
      maxGenerationsPerInvocation: number
      activeTurnDisposition: 'fail-before-recycle' | 'escalate-only'
      stallDetection: StallDetectionPolicy
      recycle: {
        mechanism: 'capability-selected' | 'in-pane-runner' | 'direct-child'
        killGraceMs: number
        killProcessTree: boolean
        restartFrom: 'latest-continuation'
        requireContinuation: boolean
      }
      onRecoveryFailure: 'fail-invocation' | 'escalate-hard-reap'
    }

export type TurnRetryPolicy =
  | { mode: 'none' }
  | {
      mode: 'safe-retry'
      maxAttempts: number
      retryOn: Array<'harness-stalled' | 'harness-crashed'>
      requires: {
        noToolCallObserved: true
        noPermissionRequestPending: true
        noPermissionRequestObserved?: true | undefined
        noAssistantFinalObserved: true
        noExternalMutationObserved: true
        continuationKnown: true
        driverCanProvePriorTurnIncomplete: true
      }
      identity: {
        inputId: 'same'
        logicalTurnId: 'same'
        turnAttempt: 'increment'
      }
      semantics: 'at-least-once'
      onUnsafe: 'fail-turn'
    }

export interface BrokerLifecyclePolicyOverlay {
  schemaVersion: 'harness-broker.lifecycle-policy/v1'
  policyId: LifecyclePolicyId
  policyHash: LifecyclePolicyHash
  retention: RuntimeRetentionPolicy
  harnessRecovery: HarnessRecoveryPolicy
  turnRetry: TurnRetryPolicy
}

export type BrokerLifecyclePolicyOverlayInput = Omit<BrokerLifecyclePolicyOverlay, 'policyHash'> &
  Partial<Pick<BrokerLifecyclePolicyOverlay, 'policyHash'>>

export type InvocationLifecycleCapabilities = {
  runtimeRetention: Array<RuntimeRetentionPolicy['mode']>
  harnessRecovery: Array<HarnessRecoveryPolicy['mode']>
  turnRetry: Array<TurnRetryPolicy['mode']>
  generationFencing: boolean
  permissionCancellation: boolean
}

export interface AcceptedLifecyclePolicy {
  policyId: LifecyclePolicyId
  policyHash: LifecyclePolicyHash
  retentionMode: RuntimeRetentionPolicy['mode']
  harnessRecoveryMode: HarnessRecoveryPolicy['mode']
  turnRetryMode: TurnRetryPolicy['mode']
}

export interface LifecyclePolicyAcceptedPayload extends AcceptedLifecyclePolicy {}

export interface LifecycleEscalationPayload {
  reason:
    | 'idle-retire-timeout'
    | 'recycle-failed'
    | 'runner-unresponsive'
    | 'retry-exhausted'
    | 'broker-degraded'
  requestedAction: 'hard-reap' | 'operator-attention'
  harnessGeneration?: number | undefined
  inputId?: InputId | undefined
  turnId?: TurnId | undefined
  turnAttempt?: number | undefined
  policyHash?: LifecyclePolicyHash | undefined
}

export interface HarnessStartedPayload {
  generation: number
  mode: 'initial' | 'recycle'
  mechanism: 'in-pane-runner' | 'direct-child'
  pid?: number | undefined
  argvHash?: string | undefined
  controlSocketId?: string | undefined
}

export interface HarnessExitedPayload {
  generation: number
  reason:
    | 'idle-retire'
    | 'operator-stop'
    | 'crash'
    | 'recycle-kill'
    | 'process-exit'
    | 'runner-exit'
  exitCode?: number | null | undefined
  signal?: string | null | undefined
}

export interface HarnessRecoveryStartedPayload {
  fromGeneration: number
  reason: 'child-exit' | 'stall' | 'healthcheck-failed'
  activeTurnDisposition: 'fail-before-recycle' | 'escalate-only' | 'none'
}

export interface HarnessRecoveryCompletedPayload {
  fromGeneration: number
  toGeneration: number
  ready: boolean
}

export interface HarnessRecoveryFailedPayload {
  fromGeneration: number
  reason: 'runner-unresponsive' | 'kill-timeout' | 'spawn-failed' | 'continuation-missing'
  requestedAction?: 'hard-reap' | undefined
}

export interface TurnStalledPayload {
  inputId: InputId
  turnId: TurnId
  noProgressMs: number
  thresholdMs: number
  healthProbe: 'runner-status' | 'driver-status' | 'native-heartbeat'
  harnessGeneration: number
  turnAttempt: number
}

export interface TurnRetryPayload {
  inputId: InputId
  turnId: TurnId
  fromAttempt: number
  toAttempt: number
  fromHarnessGeneration: number
  toHarnessGeneration: number
  reason: 'harness-stalled' | 'harness-crashed'
  semantics: 'at-least-once'
}

export interface PermissionCancelledPayload {
  permissionRequestId: PermissionRequestId
  reason: 'harness-generation-ended' | 'turn-failed' | 'invocation-stopping'
  harnessGeneration?: number | undefined
  turnAttempt?: number | undefined
}

export const CONSERVATIVE_LIFECYCLE_CAPABILITIES: InvocationLifecycleCapabilities = {
  runtimeRetention: ['keep-alive'],
  harnessRecovery: ['none'],
  turnRetry: ['none'],
  generationFencing: false,
  permissionCancellation: false,
}

export function conservativeDefaultLifecyclePolicyOverlay(
  policyId: LifecyclePolicyId
): BrokerLifecyclePolicyOverlay {
  return normalizeLifecyclePolicyOverlay({
    schemaVersion: 'harness-broker.lifecycle-policy/v1',
    policyId,
    retention: { mode: 'keep-alive' },
    harnessRecovery: { mode: 'none' },
    turnRetry: { mode: 'none' },
  })
}

export function normalizeLifecyclePolicyOverlay(
  policy: BrokerLifecyclePolicyOverlayInput
): BrokerLifecyclePolicyOverlay {
  const policyHash = lifecyclePolicyHash(policy)
  return {
    ...policy,
    policyHash,
  }
}

export function canonicalLifecyclePolicyJson(
  policy: BrokerLifecyclePolicyOverlayInput | BrokerLifecyclePolicyOverlay
): string {
  const { policyHash: _policyHash, ...hashMaterial } = policy
  return canonicalizeJson(hashMaterial)
}

export function lifecyclePolicyHash(
  policy: BrokerLifecyclePolicyOverlayInput | BrokerLifecyclePolicyOverlay
): LifecyclePolicyHash {
  return createHash('sha256').update(canonicalLifecyclePolicyJson(policy), 'utf8').digest('hex')
}

export function acceptedLifecyclePolicy(
  policy: BrokerLifecyclePolicyOverlay
): AcceptedLifecyclePolicy {
  return {
    policyId: policy.policyId,
    policyHash: policy.policyHash,
    retentionMode: policy.retention.mode,
    harnessRecoveryMode: policy.harnessRecovery.mode,
    turnRetryMode: policy.turnRetry.mode,
  }
}

function canonicalizeJson(value: unknown): string {
  if (value === null) return 'null'
  const valueType = typeof value
  if (valueType === 'string') return JSON.stringify(value)
  if (valueType === 'boolean') return value ? 'true' : 'false'
  if (valueType === 'number') {
    if (!Number.isFinite(value)) {
      throw new RangeError('canonical lifecycle policy hash forbids non-finite number')
    }
    return JSON.stringify(value)
  }
  if (valueType === 'undefined' || valueType === 'function' || valueType === 'symbol') {
    return 'null'
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  if (typeof value !== 'object') {
    return JSON.stringify(String(value))
  }

  const record = value as Record<string, unknown>
  const parts: string[] = []
  for (const key of Object.keys(record).sort()) {
    const child = record[key]
    if (child === undefined) continue
    parts.push(`${JSON.stringify(key)}:${canonicalizeJson(child)}`)
  }
  return `{${parts.join(',')}}`
}
