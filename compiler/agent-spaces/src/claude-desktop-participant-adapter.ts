import { isAbsolute } from 'node:path'
import type { InvocationStartRequest } from 'spaces-harness-broker-protocol'
import {
  type ParticipantAdapter,
  type ParticipantAdapterPreparationRequest,
  type ParticipantBrokerDescriptor,
  createCanonicalHasher,
  neutralParticipantBrokerDescriptorHash,
  neutralSpecHash,
  neutralStartRequestHash,
  validateParticipantBrokerDescriptor,
} from 'spaces-runtime-contracts'

export const CLAUDE_DESKTOP_PARTICIPANT_CLASS = 'claude-desktop'
const ADAPTER_ID = 'claude-desktop-participant-adapter/v1'
const PREPARATION_SCHEMA = 'claude-desktop.participant-preparation/1'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function participantKey(sessionId: string): string {
  return `${CLAUDE_DESKTOP_PARTICIPANT_CLASS}:${sessionId}`
}

function buildDescriptor(
  request: ParticipantAdapterPreparationRequest,
  sessionId: string
): ParticipantBrokerDescriptor {
  const { identity, workspaceCwd } = request
  const driver = CLAUDE_DESKTOP_PARTICIPANT_CLASS
  const startRequest: InvocationStartRequest = {
    spec: {
      specVersion: 'harness-broker.invocation/v1',
      invocationId: identity.invocationId,
      harness: { frontend: driver, provider: 'anthropic', driver },
      process: {
        command: 'external-claude-desktop',
        args: [],
        cwd: workspaceCwd,
        lockedEnv: {},
        harnessTransport: { kind: 'pipes' },
      },
      interaction: { mode: 'headless', turnConcurrency: 'single', inputQueue: 'fifo' },
      driver: { kind: driver, sessionId },
      correlation: {
        runtimeId: identity.runtimeId,
        hostSessionId: identity.hostSessionId,
        generation: String(identity.generation),
        invocationId: identity.invocationId,
        ...(identity.runId === undefined ? {} : { runId: identity.runId }),
        ...(identity.traceId === undefined ? {} : { traceId: identity.traceId }),
      },
    },
  }
  const startRequestHash = neutralStartRequestHash(startRequest)
  const descriptor: ParticipantBrokerDescriptor = {
    schemaVersion: 'participant-broker-descriptor/v1',
    descriptorId:
      `descriptor_${startRequestHash.slice(-32)}` as ParticipantBrokerDescriptor['descriptorId'],
    descriptorHash: '',
    compatibilityHash: createCanonicalHasher().hash({ driver, sessionId }).value,
    interactionMode: 'headless',
    expectedCapabilities: {
      input: {
        user: 'forbidden',
        steer: 'forbidden',
        appendContext: 'forbidden',
        localImages: 'forbidden',
        fileRefs: 'forbidden',
        queue: 'forbidden',
      },
      turns: { concurrency: 'single', interrupt: 'forbidden' },
      continuation: 'forbidden',
      permissions: 'none',
      events: {
        assistantDeltas: 'optional',
        toolCalls: 'optional',
        usage: 'optional',
        diagnostics: 'optional',
      },
      control: {
        stop: 'optional',
        dispose: 'required',
        reconcile: 'optional',
        attachReplay: 'required',
      },
      lifecycle: {
        runtimeRetention: ['keep-alive'],
        harnessRecovery: ['none'],
        turnRetry: ['none'],
        generationFencing: 'forbidden',
        permissionCancellation: 'forbidden',
      },
    },
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: driver,
    brokerOwnership: 'participant-owned-process',
    harnessInvocation: {
      startRequest,
      specHash: neutralSpecHash(startRequest.spec),
      startRequestHash,
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: {
        readyInput: 'start-turn',
        busy: { whenBusy: 'reject' },
        supportedKinds: [],
        attachmentPolicy: { localImages: false, fileRefs: false },
      },
      exposurePolicy: { mode: 'none' },
    },
    observability: { correlation: identity },
  }
  descriptor.descriptorHash = neutralParticipantBrokerDescriptorHash(descriptor)
  descriptor.harnessInvocation.startRequest = {
    ...startRequest,
    spec: {
      ...startRequest.spec,
      correlation: {
        ...startRequest.spec.correlation,
        startRequestHash,
        selectedProfileHash: descriptor.descriptorHash,
      },
    },
  }
  return descriptor
}

export function createClaudeDesktopParticipantAdapter(): ParticipantAdapter {
  return {
    adapterId: ADAPTER_ID,
    async admit({ classId, join, evidence }) {
      if (
        classId !== CLAUDE_DESKTOP_PARTICIPANT_CLASS ||
        join !== 'participant-served' ||
        !isRecord(evidence) ||
        evidence['entrypoint'] !== CLAUDE_DESKTOP_PARTICIPANT_CLASS ||
        typeof evidence['sessionId'] !== 'string' ||
        evidence['sessionId'] !== evidence['requestedSessionId'] ||
        typeof evidence['cwd'] !== 'string' ||
        !isAbsolute(evidence['cwd'])
      ) {
        return { status: 'rejected', reason: 'claude_desktop_session_not_verified' }
      }
      return {
        status: 'admitted',
        participantKey: participantKey(evidence['sessionId']),
        workspaceCwd: evidence['cwd'],
        preparation: { schema: PREPARATION_SCHEMA, sessionId: evidence['sessionId'] },
      }
    },
    async prepare(request) {
      const { preparation } = request
      if (
        request.classId !== CLAUDE_DESKTOP_PARTICIPANT_CLASS ||
        request.join !== 'participant-served' ||
        !isRecord(preparation) ||
        preparation['schema'] !== PREPARATION_SCHEMA ||
        typeof preparation['sessionId'] !== 'string' ||
        request.participantKey !== participantKey(preparation['sessionId'])
      ) {
        return { status: 'rejected', reason: 'claude_desktop_preparation_invalid' }
      }
      const descriptor = buildDescriptor(request, preparation['sessionId'])
      if (!validateParticipantBrokerDescriptor(descriptor).ok) {
        return { status: 'rejected', reason: 'claude_desktop_descriptor_invalid' }
      }
      return { status: 'prepared', descriptor }
    },
  }
}
