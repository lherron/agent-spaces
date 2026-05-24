// @ts-expect-error Test-only sibling import keeps agent-spaces package deps unchanged.
import { BrokerClient } from 'spaces-harness-broker-client'
import { createCanonicalHasher } from 'spaces-runtime-contracts'

import type {
  BrokerHelloResponse,
  InvocationCapabilities,
  InvocationEventEnvelope,
  PermissionRequestParams,
} from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CapabilityRequirements,
  HrcCapabilityPolicy,
} from 'spaces-runtime-contracts'
import { compileRuntimePlan } from '../compile-runtime-plan.js'
import { writePreHrcBrokerContractArtifacts } from './pre-hrc-broker-contract-artifacts.js'
import {
  assertBrokerProfileClosure,
  assertBrokerStartBaselineEvents,
  assertPreHrcRouteDecision,
  assertRealCodexHappyPath,
} from './pre-hrc-broker-contract-assertions.js'
import type {
  ContractHarnessFailure,
  PreHrcBrokerContractAssertionReport,
  PreHrcBrokerContractHarnessInput,
  PreHrcBrokerContractHarnessResult,
  PreHrcRouteDecision,
} from './pre-hrc-broker-contract-types.js'
import { PreHrcBrokerEventLedger } from './pre-hrc-broker-event-ledger.js'
import {
  ContractHarnessFailureError,
  selectBrokerProfile,
  verifyBrokerStartContract,
} from './pre-hrc-broker-helpers.js'

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

function repoRoot(): string {
  return new URL('../../../../', import.meta.url).pathname
}

function requiredFlag(
  failures: ContractHarnessFailure[],
  ok: boolean,
  path: string,
  message: string,
  details: Record<string, unknown>
): void {
  if (ok) return
  failures.push({
    code: 'broker_capability_missing',
    message,
    path,
    redactedDetails: details,
  })
}

function assertInvocationCapabilities(
  requirements: CapabilityRequirements,
  capabilities: InvocationCapabilities | undefined,
  pathPrefix: string,
  hrcPolicy: HrcCapabilityPolicy | undefined
): ContractHarnessFailure[] {
  if (capabilities === undefined) {
    return [
      {
        code: 'broker_capability_missing',
        message: 'Broker did not report invocation capabilities for the selected driver.',
        path: pathPrefix,
        redactedDetails: { hrcPolicy },
      },
    ]
  }

  const failures: ContractHarnessFailure[] = []
  for (const key of [
    'user',
    'steer',
    'appendContext',
    'localImages',
    'fileRefs',
    'queue',
  ] as const) {
    requiredFlag(
      failures,
      requirements.input[key] !== 'required' || capabilities.input[key] === true,
      `${pathPrefix}.input.${key}`,
      `Required input capability is missing: ${key}.`,
      { required: requirements.input[key], actual: capabilities.input[key], hrcPolicy }
    )
  }

  requiredFlag(
    failures,
    requirements.turns.concurrency === 'any' ||
      requirements.turns.concurrency === capabilities.turns.concurrency,
    `${pathPrefix}.turns.concurrency`,
    `Required turn concurrency is missing: ${requirements.turns.concurrency}.`,
    {
      required: requirements.turns.concurrency,
      actual: capabilities.turns.concurrency,
      hrcPolicy,
    }
  )
  requiredFlag(
    failures,
    requirements.turns.interrupt !== 'required' ||
      capabilities.turns.interrupt === 'protocol' ||
      capabilities.turns.interrupt === 'process',
    `${pathPrefix}.turns.interrupt`,
    'Required turn interrupt capability is missing.',
    { required: requirements.turns.interrupt, actual: capabilities.turns.interrupt, hrcPolicy }
  )
  requiredFlag(
    failures,
    requirements.continuation !== 'required' || capabilities.continuation.supported === true,
    `${pathPrefix}.continuation.supported`,
    'Required continuation capability is missing.',
    {
      required: requirements.continuation,
      actual: capabilities.continuation.supported,
      hrcPolicy,
    }
  )

  for (const key of ['assistantDeltas', 'toolCalls', 'usage', 'diagnostics'] as const) {
    requiredFlag(
      failures,
      requirements.events[key] !== 'required' || capabilities.events[key] === true,
      `${pathPrefix}.events.${key}`,
      `Required event capability is missing: ${key}.`,
      { required: requirements.events[key], actual: capabilities.events[key], hrcPolicy }
    )
  }

  for (const key of ['stop', 'dispose'] as const) {
    requiredFlag(
      failures,
      requirements.control[key] !== 'required' || capabilities.control[key] === true,
      `${pathPrefix}.control.${key}`,
      `Required control capability is missing: ${key}.`,
      { required: requirements.control[key], actual: capabilities.control[key], hrcPolicy }
    )
  }

  requiredFlag(
    failures,
    requirements.control.reconcile !== 'required' || capabilities.control.status === true,
    `${pathPrefix}.control.status`,
    'Required reconcile/status capability is missing.',
    { required: requirements.control.reconcile, actual: capabilities.control.status, hrcPolicy }
  )

  requiredFlag(
    failures,
    requirements.permissions === 'none' ||
      capabilities.permissions?.brokerToClientRequests === true,
    `${pathPrefix}.permissions.brokerToClientRequests`,
    'Required broker permission request capability is missing.',
    { required: requirements.permissions, actual: capabilities.permissions, hrcPolicy }
  )

  return failures
}

function assertBrokerHelloCapabilities(
  profile: BrokerExecutionProfile,
  hello: BrokerHelloResponse,
  hrcPolicy: HrcCapabilityPolicy | undefined
): ContractHarnessFailure[] {
  const failures: ContractHarnessFailure[] = []
  requiredFlag(
    failures,
    hello.capabilities.eventNotifications === true,
    'brokerHello.capabilities.eventNotifications',
    'Broker hello did not advertise event notifications.',
    { actual: hello.capabilities.eventNotifications, hrcPolicy }
  )
  requiredFlag(
    failures,
    profile.expectedCapabilities.permissions === 'none' ||
      hello.capabilities.brokerToClientRequests === true,
    'brokerHello.capabilities.brokerToClientRequests',
    'Broker hello did not advertise broker-to-client permission requests.',
    {
      required: profile.expectedCapabilities.permissions,
      actual: hello.capabilities.brokerToClientRequests,
      hrcPolicy,
    }
  )
  requiredFlag(
    failures,
    profile.expectedCapabilities.control.attachReplay !== 'required' ||
      hello.capabilities.attachReplay === true,
    'brokerHello.capabilities.attachReplay',
    'Broker hello did not advertise required attach/replay capability.',
    {
      required: profile.expectedCapabilities.control.attachReplay,
      actual: hello.capabilities.attachReplay,
      hrcPolicy,
    }
  )

  const driver = hello.drivers.find((candidate) => candidate.kind === profile.brokerDriver)
  if (driver === undefined || !driver.available) {
    failures.push({
      code: 'broker_capability_missing',
      message: 'Broker hello did not advertise an available selected driver.',
      path: 'brokerHello.drivers',
      redactedDetails: {
        brokerDriver: profile.brokerDriver,
        availableDrivers: hello.drivers.map(({ kind, available }) => ({ kind, available })),
        hrcPolicy,
      },
    })
    return failures
  }

  return [
    ...failures,
    ...assertInvocationCapabilities(
      profile.expectedCapabilities,
      driver.capabilities,
      `brokerHello.drivers.${driver.kind}.capabilities`,
      hrcPolicy
    ),
  ]
}

async function nextBrokerEvent(
  iterator: AsyncIterator<InvocationEventEnvelope>,
  timeoutMs: number
): Promise<InvocationEventEnvelope> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      iterator.next(),
      new Promise<IteratorResult<InvocationEventEnvelope>>((resolve) => {
        timer = setTimeout(() => resolve({ done: true, value: undefined }), timeoutMs)
      }),
    ])
    if (result.done === true) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for broker event.`)
    }
    return result.value
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function collectEventsUntilTerminalTurn(
  events: AsyncIterable<InvocationEventEnvelope>,
  ledger: PreHrcBrokerEventLedger,
  timeoutMs: number
): Promise<ContractHarnessFailure[]> {
  const iterator = events[Symbol.asyncIterator]()
  while (ledger.terminalTurnEvent() === undefined) {
    try {
      ledger.append(await nextBrokerEvent(iterator, timeoutMs))
    } catch (error) {
      return [
        {
          code: 'broker_event_timeout',
          message: error instanceof Error ? error.message : String(error),
        },
      ]
    }
  }
  return []
}

async function startBrokerInvocation(
  profile: BrokerExecutionProfile,
  hrcPolicy: HrcCapabilityPolicy | undefined,
  timeoutMs: number
): Promise<{
  brokerStart: NonNullable<PreHrcBrokerContractHarnessResult['brokerStart']>
  failures: ContractHarnessFailure[]
}> {
  let brokerClient: BrokerClient | undefined
  const ledger = new PreHrcBrokerEventLedger()
  const permissionAudit: Array<{ permissionRequestId: string; kind: string; decision: 'deny' }> = []

  try {
    brokerClient = await BrokerClient.start({
      command: 'bun',
      args: ['packages/harness-broker/bin/harness-broker.js', 'run', '--transport', 'stdio'],
      cwd: repoRoot(),
    })
    const hello = await brokerClient.hello({
      clientInfo: { name: 'pre-hrc-broker-contract-harness', version: '0.1.0' },
      protocolVersions: ['harness-broker/0.1'],
      capabilities: { permissionRequests: true },
    })
    const helloFailures = assertBrokerHelloCapabilities(profile, hello, hrcPolicy)
    if (helloFailures.length > 0) {
      return {
        brokerStart: { attempted: false, reason: 'capability-missing' },
        failures: helloFailures,
      }
    }

    brokerClient.onPermissionRequest(async (request: PermissionRequestParams) => {
      permissionAudit.push({
        permissionRequestId: request.permissionRequestId,
        kind: request.kind,
        decision: 'deny',
      })
      return { decision: 'deny' as const }
    })

    const startResult = await brokerClient.startInvocationFromRequest(
      profile.harnessInvocation.startRequest
    )
    const invocationFailures = assertInvocationCapabilities(
      profile.expectedCapabilities,
      startResult.response.capabilities,
      'invocationStart.response.capabilities',
      hrcPolicy
    )
    const eventFailures = await collectEventsUntilTerminalTurn(
      startResult.events,
      ledger,
      timeoutMs
    )
    const ledgerFailures = [
      ...ledger.requireMonotonicSeq(),
      ...ledger.requireNoDuplicates(),
      ...ledger.requireOnlyNormalizedEventTypes(),
    ]
    const terminalFailures =
      ledger.terminalTurnEvent() === undefined
        ? [
            {
              code: 'broker_terminal_turn_missing' as const,
              message: 'Broker event stream did not produce a terminal turn event.',
            },
          ]
        : []

    if (startResult.response.capabilities.control.dispose === true) {
      await brokerClient.dispose({ invocationId: startResult.invocationId }).catch(() => undefined)
    }

    return {
      brokerStart: {
        attempted: true,
        response: startResult.response,
        events: ledger.events(),
        eventTypes: ledger.eventTypes(),
        permissionAudit,
      },
      failures: [...invocationFailures, ...eventFailures, ...ledgerFailures, ...terminalFailures],
    }
  } catch (error) {
    return {
      brokerStart: { attempted: false, reason: 'broker-start-failed' },
      failures: [
        {
          code: 'broker_start_failed',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    }
  } finally {
    await brokerClient?.close().catch(() => undefined)
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
  let brokerStart: PreHrcBrokerContractHarnessResult['brokerStart']
  let brokerEvents: InvocationEventEnvelope[] = []
  if (mode === 'broker-start' && !contractVerificationFailed && selectedProfile !== undefined) {
    const brokerResult = await startBrokerInvocation(
      selectedProfile,
      input.compileRequest.hrcPolicy.capabilityPolicy,
      input.timeoutMs ?? selectedProfile.policy.resourceLimits?.turnTimeoutMs ?? 10_000
    )
    brokerStart = brokerResult.brokerStart
    brokerEvents =
      brokerResult.brokerStart.attempted === true ? brokerResult.brokerStart.events : []
    failures.push(...brokerResult.failures)
    if (brokerResult.brokerStart.attempted === true) {
      if (input.brokerStartAssertions?.baseline !== undefined) {
        failures.push(
          ...assertBrokerStartBaselineEvents(
            brokerResult.brokerStart.events,
            input.brokerStartAssertions.baseline
          )
        )
      }
      if (input.brokerStartAssertions?.realCodexHappyPath !== undefined) {
        failures.push(
          ...assertRealCodexHappyPath(brokerResult.brokerStart.events, {
            ...input.brokerStartAssertions.realCodexHappyPath,
            expectedCwd:
              input.brokerStartAssertions.realCodexHappyPath.expectedCwd ??
              selectedProfile.harnessInvocation.startRequest.spec.process.cwd,
          })
        )
      }
    }
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
      brokerEvents,
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
      brokerStart ??
      (mode === 'dry-run-compile'
        ? { attempted: false, reason: 'dry-run-compile' }
        : { attempted: false, reason: 'contract-verification-failed' }),
  }
}
