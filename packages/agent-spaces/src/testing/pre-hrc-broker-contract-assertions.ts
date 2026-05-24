import type { BrokerExecutionProfile, RuntimeCompileResponse } from 'spaces-runtime-contracts'

import type {
  ContractHarnessFailure,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'

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
