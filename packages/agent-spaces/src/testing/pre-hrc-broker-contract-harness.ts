import { createCanonicalHasher } from 'spaces-runtime-contracts'

import { compileRuntimePlan } from '../compile-runtime-plan.js'
import { writePreHrcBrokerContractArtifacts } from './pre-hrc-broker-contract-artifacts.js'
import {
  assertBrokerProfileClosure,
  assertPreHrcRouteDecision,
  selectBrokerExecutionProfile,
} from './pre-hrc-broker-contract-assertions.js'
import type {
  ContractHarnessFailure,
  PreHrcBrokerContractAssertionReport,
  PreHrcBrokerContractHarnessInput,
  PreHrcBrokerContractHarnessResult,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'

function routeIdFor(value: unknown): string {
  return `prehrc_route_${createCanonicalHasher().hash(value, { timestampMode: 'omit-ephemeral' }).value.slice(0, 32)}`
}

function createPreHrcRouteDecision(
  plan: NonNullable<PreHrcBrokerContractHarnessResult['compiledPlan']>,
  profile: NonNullable<PreHrcBrokerContractHarnessResult['selectedProfile']>
): PreHrcRouteDecision {
  return {
    schemaVersion: 'pre-hrc-route-decision/v1',
    routeId: routeIdFor({
      compileId: plan.compileId,
      planHash: plan.planHash,
      selectedProfileId: profile.profileId,
      selectedProfileHash: profile.profileHash,
    }),
    operationId: plan.identity.operationId,
    compileId: plan.compileId,
    planHash: plan.planHash,
    selectedProfileId: profile.profileId,
    selectedProfileHash: profile.profileHash,
    selectedProfileKind: 'harness-broker',
    controller: 'harness-broker',
    startupMethod: 'create-broker-invocation',
    turnDelivery: 'broker-input',
    identity: plan.identity,
    admission: { decision: 'admit' },
    reuse: {
      policy: 'always-new',
      compatibilityHash: profile.compatibilityHash,
      staleGeneration: 'rotate',
    },
    productPolicy: {
      permissionPolicy: profile.policy.permissionPolicy,
      inputPolicy: profile.policy.inputPolicy,
      exposurePolicy: profile.policy.exposurePolicy,
      ...(profile.policy.resourceLimits !== undefined
        ? { resourceLimits: profile.policy.resourceLimits }
        : {}),
    },
    diagnostics: plan.diagnostics.map(({ level, code, message }) => ({ level, code, message })),
  }
}

export async function runPreHrcBrokerContractHarness(
  input: PreHrcBrokerContractHarnessInput
): Promise<PreHrcBrokerContractHarnessResult> {
  const mode = input.dryRunCompile === false ? 'broker-start' : 'dry-run-compile'
  const compileResponse = await compileRuntimePlan(input.compileRequest, {
    clientAspHome: input.aspHome,
  })
  const selection = selectBrokerExecutionProfile(compileResponse)
  const selectedProfile = selection.profile
  const compiledPlan = compileResponse.ok ? compileResponse.plan : undefined
  const routeDecision =
    compiledPlan !== undefined && selectedProfile !== undefined
      ? createPreHrcRouteDecision(compiledPlan, selectedProfile)
      : undefined

  const failures: ContractHarnessFailure[] = [
    ...selection.failures,
    ...assertBrokerProfileClosure(compileResponse, selectedProfile),
    ...assertPreHrcRouteDecision(routeDecision, selectedProfile, compileResponse),
  ]

  if (mode === 'broker-start') {
    failures.push({
      code: 'broker_start_not_implemented',
      message:
        'Broker start is intentionally not implemented in the P1 pre-HRC harness skeleton; rerun with --dry-run-compile.',
    })
  }

  const assertionReport: PreHrcBrokerContractAssertionReport = {
    schemaVersion: 'pre-hrc-broker-contract-assertion-report/v1',
    ok: failures.length === 0,
    failures,
    diagnostics: compileResponse.diagnostics,
  }

  let artifactFailures: ContractHarnessFailure[] = []
  let artifacts: PreHrcBrokerContractHarnessResult['artifacts']
  if (input.artifactDir !== undefined) {
    const written = await writePreHrcBrokerContractArtifacts({
      artifactDir: input.artifactDir,
      compileRequest: input.compileRequest,
      compiledPlan,
      selectedProfile,
      routeDecision,
      brokerEvents: [],
      assertionReport,
      writeRawStartRequest: input.writeRawStartRequest,
    })
    artifacts = written.manifest
    artifactFailures = written.failures
  }

  const allFailures = [...failures, ...artifactFailures]
  const finalAssertionReport: PreHrcBrokerContractAssertionReport = {
    ...assertionReport,
    ok: allFailures.length === 0,
    failures: allFailures,
  }

  return {
    schemaVersion: 'pre-hrc-broker-contract-harness-result/v1',
    ok: allFailures.length === 0,
    mode,
    compileResponse,
    compiledPlan,
    selectedProfile,
    routeDecision,
    artifacts,
    assertionReport: finalAssertionReport,
    brokerStart:
      mode === 'dry-run-compile'
        ? { attempted: false, reason: 'dry-run-compile' }
        : { attempted: false, reason: 'not-implemented' },
  }
}
