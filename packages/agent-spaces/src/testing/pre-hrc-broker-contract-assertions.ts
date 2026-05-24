import type { InvocationEventEnvelope } from 'spaces-harness-broker-protocol'
import type { BrokerExecutionProfile, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import type {
  ContractHarnessFailure,
  PreHrcBrokerContractHarnessInput,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'

type BrokerStartAssertions = NonNullable<PreHrcBrokerContractHarnessInput['brokerStartAssertions']>
type TerminalTurnType = NonNullable<
  NonNullable<BrokerStartAssertions['baseline']>['expectedTerminalType']
>

const TERMINAL_TURN_EVENT_TYPES = new Set<TerminalTurnType>([
  'turn.completed',
  'turn.failed',
  'turn.interrupted',
])

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function commandIsPwdOnly(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const trimmed = command.trim()
  if (/[;&|]/.test(trimmed)) return false

  const shellWrapped = trimmed.match(/^(?:\S+|\[REDACTED\])\s+-lc\s+(.+)$/)
  const candidate = (shellWrapped?.[1] ?? trimmed).trim().replace(/^['"]|['"]$/g, '')
  return /^(?:\/bin\/)?pwd$/.test(candidate)
}

function normalizedPathOutput(output: string): string {
  return output.trim().replace(/\r\n/g, '\n')
}

function outputMatchesExpectedCwd(output: unknown, expectedCwd: string): boolean {
  if (typeof output !== 'string') return false
  const trimmed = normalizedPathOutput(output)
  return trimmed === expectedCwd || trimmed.includes(expectedCwd)
}

function assistantTexts(events: readonly InvocationEventEnvelope[]): string[] {
  const texts: string[] = []
  let deltaText = ''
  for (const event of events) {
    const payload = asRecord(event.payload)
    if (event.type === 'assistant.message.delta' && typeof payload?.['text'] === 'string') {
      deltaText += payload['text']
    }
    if (event.type === 'assistant.message.completed') {
      const content = Array.isArray(payload?.['content']) ? payload['content'] : []
      const text = content
        .map((part) => {
          const record = asRecord(part)
          return record?.['type'] === 'text' ? String(record['text'] ?? '') : ''
        })
        .join('')
      if (text.length > 0) texts.push(text)
    }
    if (event.type === 'turn.completed' && typeof payload?.['finalOutput'] === 'string') {
      texts.push(payload['finalOutput'])
    }
  }
  if (deltaText.length > 0) texts.push(deltaText)
  return texts
}

export function selectBrokerExecutionProfile(compileResponse: RuntimeCompileResponse): {
  profile?: BrokerExecutionProfile | undefined
  failures: ContractHarnessFailure[]
} {
  const failures: ContractHarnessFailure[] = []
  if (!compileResponse.ok) {
    failures.push({
      code: 'compile_failed',
      message: 'compileRuntimePlan returned diagnostics instead of a compiled plan.',
      redactedDetails: { diagnostics: compileResponse.diagnostics },
    })
    return { failures }
  }

  const profiles = compileResponse.plan.executionProfiles.filter(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )
  if (profiles.length === 0) {
    failures.push({
      code: 'broker_profile_missing',
      message: 'Compiled plan did not contain a harness-broker execution profile.',
      path: 'plan.executionProfiles',
    })
    return { failures }
  }
  if (profiles.length > 1) {
    failures.push({
      code: 'broker_profile_ambiguous',
      message: 'Compiled plan contained more than one harness-broker execution profile.',
      path: 'plan.executionProfiles',
      redactedDetails: { count: profiles.length },
    })
    return { profile: profiles[0], failures }
  }
  return { profile: profiles[0], failures }
}

export function assertBrokerProfileClosure(
  compileResponse: RuntimeCompileResponse,
  profile: BrokerExecutionProfile | undefined
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  if (!compileResponse.ok) return failures
  if (profile === undefined) {
    failures.push({
      code: 'broker_profile_missing',
      message: 'Cannot assert broker profile closure without a selected profile.',
      path: 'plan.executionProfiles',
    })
    return failures
  }

  if (profile.kind !== 'harness-broker') {
    failures.push({
      code: 'broker_profile_invalid',
      message: 'Selected profile is not a harness-broker profile.',
      path: 'selectedProfile.kind',
      redactedDetails: { kind: profile.kind },
    })
  }
  if (profile.brokerProtocol !== 'harness-broker/0.1') {
    failures.push({
      code: 'broker_protocol_invalid',
      message: 'Selected broker profile does not target harness-broker/0.1.',
      path: 'selectedProfile.brokerProtocol',
      redactedDetails: { brokerProtocol: profile.brokerProtocol },
    })
  }
  if (!profile.brokerDriver) {
    failures.push({
      code: 'broker_driver_missing',
      message: 'Selected broker profile has no broker driver.',
      path: 'selectedProfile.brokerDriver',
    })
  }
  if (profile.harnessInvocation?.startRequest === undefined) {
    failures.push({
      code: 'start_request_missing',
      message: 'Selected broker profile has no invocation start request.',
      path: 'selectedProfile.harnessInvocation.startRequest',
    })
    return failures
  }

  const startRequest = profile.harnessInvocation.startRequest
  if (startRequest.spec.specVersion !== 'harness-broker.invocation/v1') {
    failures.push({
      code: 'start_request_missing',
      message: 'Selected broker profile start request has an invalid broker spec version.',
      path: 'selectedProfile.harnessInvocation.startRequest.spec.specVersion',
      redactedDetails: { specVersion: startRequest.spec.specVersion },
    })
  }
  const identityInvocationId = compileResponse.plan.identity.invocationId
  if (
    identityInvocationId !== undefined &&
    startRequest.spec.invocationId !== undefined &&
    identityInvocationId !== startRequest.spec.invocationId
  ) {
    failures.push({
      code: 'start_request_identity_mismatch',
      message: 'Compiled runtime identity invocationId does not match the broker start request.',
      path: 'selectedProfile.harnessInvocation.startRequest.spec.invocationId',
      redactedDetails: {
        identityInvocationId,
        startRequestInvocationId: startRequest.spec.invocationId,
      },
    })
  }
  if (profile.harnessInvocation.startRequest !== startRequest) {
    failures.push({
      code: 'start_request_reference_changed',
      message: 'Selected profile did not preserve the broker start request reference.',
      path: 'selectedProfile.harnessInvocation.startRequest',
    })
  }

  return failures
}

export function assertPreHrcRouteDecision(
  decision: PreHrcRouteDecision | undefined,
  profile: BrokerExecutionProfile | undefined,
  compileResponse: RuntimeCompileResponse
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  if (decision === undefined || profile === undefined || !compileResponse.ok) return failures
  const checks: Array<[boolean, string, string]> = [
    [
      decision.schemaVersion === 'pre-hrc-route-decision/v1',
      'routeDecision.schemaVersion',
      'Pre-HRC route decision schemaVersion must be pre-hrc-route-decision/v1.',
    ],
    [
      decision.controller === 'harness-broker',
      'routeDecision.controller',
      'Pre-HRC route decision must select the harness-broker controller.',
    ],
    [
      decision.startupMethod === 'create-broker-invocation',
      'routeDecision.startupMethod',
      'Pre-HRC route decision must use create-broker-invocation startup.',
    ],
    [
      decision.turnDelivery === 'broker-input',
      'routeDecision.turnDelivery',
      'Pre-HRC route decision must use broker-input turn delivery.',
    ],
    [
      decision.selectedProfileId === profile.profileId,
      'routeDecision.selectedProfileId',
      'Pre-HRC route decision selectedProfileId must match the selected profile.',
    ],
    [
      decision.selectedProfileHash === profile.profileHash,
      'routeDecision.selectedProfileHash',
      'Pre-HRC route decision selectedProfileHash must match the selected profile.',
    ],
    [
      decision.compileId === compileResponse.plan.compileId,
      'routeDecision.compileId',
      'Pre-HRC route decision compileId must match the compiled plan.',
    ],
    [
      decision.planHash === compileResponse.plan.planHash,
      'routeDecision.planHash',
      'Pre-HRC route decision planHash must match the compiled plan.',
    ],
  ]

  for (const [ok, path, message] of checks) {
    if (!ok) failures.push({ code: 'route_decision_invalid', message, path })
  }
  return failures
}

export function assertBrokerStartBaselineEvents(
  events: readonly InvocationEventEnvelope[],
  options: NonNullable<BrokerStartAssertions['baseline']> = {}
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  const eventTypes = new Set(events.map((event) => event.type))
  const requiredTypes = [
    'invocation.started',
    'invocation.ready',
    ...(options.expectInitialInputAccepted === true ? ['input.accepted' as const] : []),
    'turn.started',
  ] as const

  for (const type of requiredTypes) {
    if (!eventTypes.has(type)) {
      failures.push({
        code: 'broker_event_baseline_missing',
        message: `Broker event stream did not include required baseline event: ${type}.`,
        path: 'brokerEvents',
        redactedDetails: { requiredType: type, observedTypes: [...eventTypes] },
      })
    }
  }

  const terminalTurns = events.filter((event): event is InvocationEventEnvelope => {
    return TERMINAL_TURN_EVENT_TYPES.has(event.type as TerminalTurnType)
  })
  if (terminalTurns.length !== 1) {
    failures.push({
      code: 'broker_terminal_turn_count_invalid',
      message: 'Broker event stream must contain exactly one terminal turn event.',
      path: 'brokerEvents',
      redactedDetails: {
        count: terminalTurns.length,
        terminalTypes: terminalTurns.map((event) => event.type),
      },
    })
  }

  const expectedTerminalType = options.expectedTerminalType
  const terminalTurn = terminalTurns[0]
  if (expectedTerminalType !== undefined && terminalTurn !== undefined) {
    const payload = asRecord(terminalTurn.payload)
    const status = payload?.['status']
    if (terminalTurn.type !== expectedTerminalType) {
      failures.push({
        code: 'broker_terminal_turn_count_invalid',
        message: `Broker terminal turn event must be ${expectedTerminalType}.`,
        path: `brokerEvents.${terminalTurn.invocationId}.${terminalTurn.seq}.type`,
        redactedDetails: { expectedTerminalType, actualType: terminalTurn.type, status },
      })
    }
  }

  return failures
}

export function assertRealCodexHappyPath(
  events: readonly InvocationEventEnvelope[],
  options: NonNullable<BrokerStartAssertions['realCodexHappyPath']>
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  const expectedCwd = options.expectedCwd

  const commandStarted = events.find((event) => {
    if (event.type !== 'tool.call.started') return false
    const payload = asRecord(event.payload)
    return payload?.['name'] === 'command'
  })
  const startedPayload = asRecord(commandStarted?.payload)
  const commandInput = asRecord(startedPayload?.['input'])
  const toolCallId = startedPayload?.['toolCallId']

  if (commandStarted === undefined || startedPayload === undefined || commandInput === undefined) {
    failures.push({
      code: 'real_codex_tool_call_missing',
      message: 'Real-Codex scenario did not emit a command tool.call.started payload.',
      path: 'brokerEvents',
    })
    return failures
  }

  if (typeof toolCallId !== 'string' || toolCallId.length === 0) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command tool.call.started payload is missing toolCallId.',
      path: `brokerEvents.${commandStarted.invocationId}.${commandStarted.seq}.payload.toolCallId`,
    })
  }
  if (!commandIsPwdOnly(commandInput['command'])) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command tool call must execute pwd only.',
      path: `brokerEvents.${commandStarted.invocationId}.${commandStarted.seq}.payload.input.command`,
      redactedDetails: { command: commandInput['command'] },
    })
  }
  if (expectedCwd !== undefined && commandInput['cwd'] !== expectedCwd) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command tool call cwd must match the compiled broker process cwd.',
      path: `brokerEvents.${commandStarted.invocationId}.${commandStarted.seq}.payload.input.cwd`,
      redactedDetails: { expectedCwd, actualCwd: commandInput['cwd'] },
    })
  }
  if (typeof commandStarted.turnId !== 'string' || commandStarted.turnId.length === 0) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command tool.call.started event is missing turnId.',
      path: `brokerEvents.${commandStarted.invocationId}.${commandStarted.seq}.turnId`,
    })
  }
  if (typeof commandStarted.itemId !== 'string' || commandStarted.itemId.length === 0) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command tool.call.started event is missing itemId.',
      path: `brokerEvents.${commandStarted.invocationId}.${commandStarted.seq}.itemId`,
    })
  }

  const commandCompleted =
    typeof toolCallId === 'string'
      ? events.find((event) => {
          if (event.type !== 'tool.call.completed') return false
          const payload = asRecord(event.payload)
          return payload?.['toolCallId'] === toolCallId
        })
      : undefined
  const completedPayload = asRecord(commandCompleted?.payload)
  const commandResult = asRecord(completedPayload?.['result'])

  if (
    commandCompleted === undefined ||
    completedPayload === undefined ||
    commandResult === undefined
  ) {
    failures.push({
      code: 'real_codex_tool_call_missing',
      message: 'Real-Codex scenario did not emit matching command tool.call.completed payload.',
      path: 'brokerEvents',
      redactedDetails: { toolCallId },
    })
    return failures
  }

  if (completedPayload['name'] !== 'command') {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command completion name must be command.',
      path: `brokerEvents.${commandCompleted.invocationId}.${commandCompleted.seq}.payload.name`,
      redactedDetails: { name: completedPayload['name'] },
    })
  }
  if (completedPayload['isError'] === true) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex command completion must not be an error.',
      path: `brokerEvents.${commandCompleted.invocationId}.${commandCompleted.seq}.payload.isError`,
    })
  }
  if (commandResult['exitCode'] !== 0) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex pwd command must exit with code 0.',
      path: `brokerEvents.${commandCompleted.invocationId}.${commandCompleted.seq}.payload.result.exitCode`,
      redactedDetails: { exitCode: commandResult['exitCode'] },
    })
  }
  if (
    expectedCwd !== undefined &&
    !outputMatchesExpectedCwd(commandResult['output'], expectedCwd)
  ) {
    failures.push({
      code: 'real_codex_tool_call_invalid',
      message: 'Real-Codex pwd command output must match the compiled broker process cwd.',
      path: `brokerEvents.${commandCompleted.invocationId}.${commandCompleted.seq}.payload.result.output`,
      redactedDetails: { expectedCwd },
    })
  }

  if (!assistantTexts(events).some((text) => text.includes(options.expectedAssistantMarker))) {
    failures.push({
      code: 'real_codex_assistant_marker_missing',
      message: `Real-Codex assistant output did not include marker ${options.expectedAssistantMarker}.`,
      path: 'brokerEvents',
      redactedDetails: { expectedAssistantMarker: options.expectedAssistantMarker },
    })
  }

  return failures
}
