import type { ParticipantAdapter, ParticipantBrokerDescriptor } from 'spaces-runtime-contracts'

export type HrcSocketPath = string

export type ExpectedPredecessor = {
  hostIncarnationId: string
  runtimeId: string
  generation: number
}

export type JoinRegisterRequest = {
  registrationMode: 'direct'
  requestedSessionRef: string
  hostIncarnationId: string
  laneRef?: string | undefined
  classId?: string | undefined
  participantKey?: string | undefined
  workspaceCwd?: string | undefined
  socketPath?: string | undefined
  expectedPredecessor?: ExpectedPredecessor | undefined
}

export type RegisteredIdentity = {
  registrationId: string
  laneRef: string
  runtimeId: string
  attemptId: string
  invocationId: string
  attachEpoch: number
  requestId: string
  operationId: string
}

export type JoinRegisterRegistered = {
  outcome: 'registered'
  httpStatus: number
  scopeRef: string
  hostSessionId: string
  generation: number
  created: boolean
  resumed: boolean
  observation: { state: 'prepared' | 'attachment_pending' | 'attached'; detail: string }
  identity: RegisteredIdentity
  continuation?:
    | { carried: boolean; reason: string; selected: unknown; resumeState: string }
    | undefined
}

export type JoinRegisterRefused = {
  outcome: 'pending' | 'rejected'
  httpStatus: number
  reason: string
  detail: string
  /** HRC's structured refusal reason from the error detail, when it sent one. */
  refusalReason?: string | undefined
  observed?: { homeNodeId?: string | undefined } | undefined
}

export type JoinRegisterResult = JoinRegisterRegistered | JoinRegisterRefused

export type JoinAttachRequest = {
  registrationId: string
  attemptId: string
  attachEpoch: number
  socketPath?: string | undefined
  descriptor: ParticipantBrokerDescriptor
  dispatchEnv?: Record<string, string> | undefined
}

export type JoinAttachAttached = {
  outcome: 'attached'
  httpStatus: number
  registrationId: string
  attemptId: string
  attachEpoch: number
  prepared: boolean
  observation: { state: 'attached'; detail: string }
}

export type JoinAttachRefused = {
  outcome: 'pending' | 'rejected'
  httpStatus: number
  reason: string
  detail: string
}

export type JoinAttachResult = JoinAttachAttached | JoinAttachRefused

export type JoinPrepareInput = {
  classId: string
  participantKey: string
  workspaceCwd: string
  preparation: unknown
}

export type JoinArgs = {
  hrcSocketPath: HrcSocketPath
  register: JoinRegisterRequest
  prepare: JoinPrepareInput
  adapter: ParticipantAdapter
}

export type JoinResult =
  | { outcome: 'attached'; register: JoinRegisterRegistered; attach: JoinAttachAttached }
  | { outcome: 'register-refused'; register: JoinRegisterRefused }
  | { outcome: 'not-prepared'; register: JoinRegisterRegistered; reason: string }
  | {
      outcome: 'attach-refused'
      register: JoinRegisterRegistered
      attach: JoinAttachRefused
    }
