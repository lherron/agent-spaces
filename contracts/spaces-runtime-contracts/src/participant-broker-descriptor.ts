import {
  type InvocationStartRequest,
  validateInvocationStartRequest,
} from 'spaces-harness-broker-protocol'
import type { CapabilityRequirements } from './capabilities'
import type { BrokerContinuationRef, RuntimeContinuationRef } from './continuation'
import type { AgentchatExposurePolicy, BrokerTerminalSurface } from './exposure'
import { createCanonicalHasher, hashNeutralStartRequest } from './hash'
import type { Id, SpecHash, StartRequestHash } from './ids'
import type { BrokerInputPolicy } from './input'
import type { BrokerObservabilityContract } from './observability'
import type { BrokerPermissionPolicy } from './permissions'
import type { InteractionMode } from './primitives'
import type { RuntimeResourceLimits } from './resources'

/** The only accepted schema at the participant attach boundary. */
export const PARTICIPANT_BROKER_DESCRIPTOR_SCHEMA_VERSION = 'participant-broker-descriptor/v1'

/** A participant-owned name, deliberately not a selected runtime profile id. */
export type ParticipantBrokerDescriptorId = Id<'participantBrokerDescriptor'>
export type ParticipantBrokerDescriptorHash = string

/**
 * Complete broker material prepared by a named participant operation.
 *
 * This is intentionally not part of the ordinary runtime-profile selection
 * union. Participant attach is an explicit operation with independently
 * allocated identity, ownership, and validation.
 */
export type ParticipantBrokerDescriptor = {
  schemaVersion: typeof PARTICIPANT_BROKER_DESCRIPTOR_SCHEMA_VERSION
  descriptorId: ParticipantBrokerDescriptorId
  descriptorHash: ParticipantBrokerDescriptorHash
  compatibilityHash: string
  interactionMode: InteractionMode
  expectedCapabilities: CapabilityRequirements

  brokerProtocol: 'harness-broker/0.2'
  brokerDriver: string
  brokerOwnership: 'hrc-owned-process' | 'participant-owned-process'
  brokerTerminal?: BrokerTerminalSurface | undefined

  harnessInvocation: {
    startRequest: InvocationStartRequest
    specHash: SpecHash
    startRequestHash: StartRequestHash
    initialInputHash?: string | undefined
  }

  policy: {
    permissionPolicy: BrokerPermissionPolicy
    inputPolicy: BrokerInputPolicy
    exposurePolicy: AgentchatExposurePolicy
    resourceLimits?: RuntimeResourceLimits | undefined
    disallowedTools?: string[] | undefined
  }

  continuation?:
    | {
        hrc?: RuntimeContinuationRef | undefined
        broker?: BrokerContinuationRef | undefined
      }
    | undefined

  observability: BrokerObservabilityContract
}

export type ParticipantBrokerDescriptorValidationIssue = {
  path: string
  message: string
}

export type ParticipantBrokerDescriptorValidationResult =
  | { ok: true; value: ParticipantBrokerDescriptor }
  | { ok: false; issues: ParticipantBrokerDescriptorValidationIssue[] }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function pushIssue(
  issues: ParticipantBrokerDescriptorValidationIssue[],
  path: string,
  message: string
): void {
  issues.push({ path, message })
}

/**
 * Hash only the durable participant descriptor material. This keeps the
 * established neutral start-request and generation-only correlation semantics
 * without using the retired runtime-profile projection.
 */
export function neutralParticipantBrokerDescriptorHash(
  descriptor: ParticipantBrokerDescriptor
): ParticipantBrokerDescriptorHash {
  const {
    descriptorHash: _descriptorHash,
    compatibilityHash: _compatibilityHash,
    harnessInvocation,
    observability,
    ...material
  } = descriptor
  return createCanonicalHasher().hash(
    {
      ...material,
      harnessInvocation: {
        ...harnessInvocation,
        startRequest: hashNeutralStartRequest(harnessInvocation.startRequest),
      },
      observability: {
        correlation: { generation: observability.correlation.generation },
      },
    },
    { timestampMode: 'omit-ephemeral' }
  ).value
}

/**
 * First typed boundary for participant attach material. It accepts only the
 * descriptor schema, so a retired `agent-runtime-profile/v1` object cannot be
 * interpreted as participant input or fall through to a legacy validator.
 */
export function validateParticipantBrokerDescriptor(
  value: unknown
): ParticipantBrokerDescriptorValidationResult {
  const issues: ParticipantBrokerDescriptorValidationIssue[] = []
  if (!isRecord(value)) {
    return {
      ok: false,
      issues: [{ path: '', message: 'Participant broker descriptor must be an object.' }],
    }
  }
  if (
    !hasOnlyKeys(value, [
      'schemaVersion',
      'descriptorId',
      'descriptorHash',
      'compatibilityHash',
      'interactionMode',
      'expectedCapabilities',
      'brokerProtocol',
      'brokerDriver',
      'brokerOwnership',
      'brokerTerminal',
      'harnessInvocation',
      'policy',
      'continuation',
      'observability',
    ])
  ) {
    pushIssue(issues, '', 'Participant broker descriptor has extra fields.')
  }
  if (value['schemaVersion'] !== PARTICIPANT_BROKER_DESCRIPTOR_SCHEMA_VERSION) {
    pushIssue(
      issues,
      'schemaVersion',
      `Participant broker descriptor schemaVersion must be ${PARTICIPANT_BROKER_DESCRIPTOR_SCHEMA_VERSION}.`
    )
  }
  for (const key of [
    'descriptorId',
    'descriptorHash',
    'compatibilityHash',
    'brokerDriver',
  ] as const) {
    if (typeof value[key] !== 'string' || value[key].length === 0) {
      pushIssue(issues, key, `Participant broker descriptor requires a non-empty ${key}.`)
    }
  }
  if (!['headless', 'interactive', 'nonInteractive'].includes(value['interactionMode'] as string)) {
    pushIssue(
      issues,
      'interactionMode',
      'Participant broker descriptor has an invalid interactionMode.'
    )
  }
  if (!isRecord(value['expectedCapabilities'])) {
    pushIssue(
      issues,
      'expectedCapabilities',
      'Participant broker descriptor requires expectedCapabilities.'
    )
  }
  if (value['brokerProtocol'] !== 'harness-broker/0.2') {
    pushIssue(
      issues,
      'brokerProtocol',
      'Participant broker descriptor must use harness-broker/0.2.'
    )
  }
  if (
    value['brokerOwnership'] !== 'hrc-owned-process' &&
    value['brokerOwnership'] !== 'participant-owned-process'
  ) {
    pushIssue(
      issues,
      'brokerOwnership',
      'Participant broker descriptor has an invalid brokerOwnership.'
    )
  }
  if (value['brokerTerminal'] !== undefined && !isRecord(value['brokerTerminal'])) {
    pushIssue(
      issues,
      'brokerTerminal',
      'Participant broker descriptor brokerTerminal must be an object.'
    )
  }
  const invocation = value['harnessInvocation']
  if (!isRecord(invocation)) {
    pushIssue(
      issues,
      'harnessInvocation',
      'Participant broker descriptor requires harnessInvocation.'
    )
  } else {
    if (
      !hasOnlyKeys(invocation, ['startRequest', 'specHash', 'startRequestHash', 'initialInputHash'])
    ) {
      pushIssue(issues, 'harnessInvocation', 'Participant broker invocation has extra fields.')
    }
    if (!isRecord(invocation['startRequest']) || !isRecord(invocation['startRequest']['spec'])) {
      pushIssue(
        issues,
        'harnessInvocation.startRequest',
        'Participant broker descriptor requires a start request.'
      )
    } else {
      try {
        validateInvocationStartRequest(invocation['startRequest'])
      } catch (error) {
        pushIssue(
          issues,
          'harnessInvocation.startRequest',
          `Participant broker descriptor has an invalid start request: ${error instanceof Error ? error.message : String(error)}`
        )
      }
    }
    for (const key of ['specHash', 'startRequestHash'] as const) {
      if (typeof invocation[key] !== 'string' || invocation[key].length === 0) {
        pushIssue(
          issues,
          `harnessInvocation.${key}`,
          `Participant broker invocation requires ${key}.`
        )
      }
    }
    if (
      invocation['initialInputHash'] !== undefined &&
      (typeof invocation['initialInputHash'] !== 'string' ||
        invocation['initialInputHash'].length === 0)
    ) {
      pushIssue(
        issues,
        'harnessInvocation.initialInputHash',
        'Participant broker invocation initialInputHash must be non-empty when present.'
      )
    }
  }
  if (!isRecord(value['policy'])) {
    pushIssue(issues, 'policy', 'Participant broker descriptor requires policy.')
  }
  if (value['continuation'] !== undefined && !isRecord(value['continuation'])) {
    pushIssue(
      issues,
      'continuation',
      'Participant broker descriptor continuation must be an object.'
    )
  }
  if (!isRecord(value['observability']) || !isRecord(value['observability']['correlation'])) {
    pushIssue(
      issues,
      'observability.correlation',
      'Participant broker descriptor requires observability correlation.'
    )
  }
  return issues.length === 0
    ? { ok: true, value: value as ParticipantBrokerDescriptor }
    : { ok: false, issues }
}
