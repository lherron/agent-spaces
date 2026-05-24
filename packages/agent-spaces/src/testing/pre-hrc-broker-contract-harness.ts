import { createCanonicalHasher } from 'spaces-runtime-contracts'

import { compileRuntimePlan } from '../compile-runtime-plan.js'
import { writePreHrcBrokerContractArtifacts } from './pre-hrc-broker-contract-artifacts.js'
import {
  assertBrokerProfileClosure,
  assertPreHrcRouteDecision,
} from './pre-hrc-broker-contract-assertions.js'
import {
  ContractHarnessFailureError,
  selectBrokerProfile,
  verifyBrokerStartContract,
} from './pre-hrc-broker-helpers.js'
import type { BrokerExecutionProfile } from 'spaces-runtime-contracts'
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
  const compiledPlan = compileResponse.ok ? compileResponse.plan : undefined

  // Select the harness-broker profile via the shared named helper (P2). Failure
  // to find a compatible profile is surfaced as a structured failure rather than
  // an unhandled throw so the assertion report stays complete.
  const selectionFailures: ContractHarnessFailure[] = []
  let selectedProfile: BrokerExecutionProfile | undefined
  if (!compileResponse.ok) {
    selectionFailures.push({
      code: 'compile_failed',
      message: 'compileRuntimePlan returned diagnostics instead of a compiled plan.',
      redactedDetails: { diagnostics: compileResponse.diagnostics },
    })
  } else {
    try {
      selectedProfile = selectBrokerProfile(compileResponse.plan, input.profileSelector)
    } catch (error) {
      if (error instanceof ContractHarnessFailureError) {
        selectionFailures.push(error.failure)
      } else {
        throw error
      }
    }
  }

  // TEST-ONLY seam: simulate local code mutating the start request between
  // compile and broker start so the closure verifier below can be exercised.
  if (selectedProfile !== undefined && input.mutateProfileForTest !== undefined) {
    input.mutateProfileForTest(selectedProfile)
  }

  // Compiler-closure verification (P3): recompute spec/start-request hashes and
  // assert immutability BEFORE any broker start. Deep-freezes the start request
  // on success.
  const verification =
    selectedProfile !== undefined ? verifyBrokerStartContract(selectedProfile) : undefined

  const routeDecision =
    compiledPlan !== undefined && selectedProfile !== undefined
      ? createPreHrcRouteDecision(compiledPlan, selectedProfile)
      : undefined

  const failures: ContractHarnessFailure[] = [
    ...selectionFailures,
    ...assertBrokerProfileClosure(compileResponse, selectedProfile),
    ...(verification?.failures ?? []),
    ...assertPreHrcRouteDecision(routeDecision, selectedProfile, compileResponse),
  ]

  const contractVerificationFailed = verification !== undefined && !verification.ok
  if (mode === 'broker-start' && !contractVerificationFailed) {
    failures.push({
      code: 'broker_start_not_implemented',
      message:
        'Broker start is intentionally not implemented in the pre-HRC harness skeleton; rerun with --dry-run-compile.',
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
        : contractVerificationFailed
          ? { attempted: false, reason: 'contract-verification-failed' }
          : { attempted: false, reason: 'not-implemented' },
  }
}
