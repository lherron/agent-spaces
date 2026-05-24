/**
 * P2 helper-extraction + P3 contract-verifier coverage (pre-HRC plan §5.2–5.6).
 *
 * - selectBrokerProfile / allocatePreHrcRuntimeIdentity / buildPlacementFromScopeRef
 *   are the reusable named helpers P4/P7 consume.
 * - verifyBrokerStartContract is the compiler-closure gate that runs immediately
 *   before broker start: it recomputes specHash / startRequestHash and FAILS the
 *   run if local code mutated the selected start request after compile.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { InputId, InvocationEventEnvelope, InvocationId } from 'spaces-harness-broker-protocol'
import type {
  BrokerExecutionProfile,
  CompiledRuntimePlan,
  RuntimeCompileRequest,
  RuntimeCompileResponse,
} from 'spaces-runtime-contracts'
import { DEFAULT_CODEX_BROKER_INPUT_POLICY } from 'spaces-runtime-contracts'

import { createAgentSpacesClient } from '../index.js'
import { runPreHrcBrokerContractHarness } from '../testing/pre-hrc-broker-contract-harness.js'
import { PreHrcBrokerEventLedger } from '../testing/pre-hrc-broker-event-ledger.js'
import {
  ContractHarnessFailureError,
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
  selectBrokerProfile,
  verifyBrokerStartContract,
} from '../testing/pre-hrc-broker-helpers.js'

const SECRET_VALUE = 'sk-FAKE-SECRET-01621'

type CompileClient = ReturnType<typeof createAgentSpacesClient> & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

const fakeCodexStartFreshTurn = new URL(
  '../../../harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
  import.meta.url
).pathname

function createCodexShim(dir: string): string {
  const shimPath = join(dir, 'codex')
  writeFileSync(
    shimPath,
    `#!/usr/bin/env bash
if [[ "$*" == *"--version"* ]]; then
  echo "codex 999.0.0"
  exit 0
fi
if [[ "$*" == *"app-server"* && "$*" == *"--help"* ]]; then
  echo "app-server"
  exit 0
fi
if [[ "$*" == *"app-server"* ]]; then
  exec bun "${fakeCodexStartFreshTurn}"
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createFixture(): {
  agentRoot: string
  projectRoot: string
  aspHome: string
  cleanup: () => void
} {
  const base = mkdtempSync(join(tmpdir(), 'asp-prehrc-verifier-'))
  const agentRoot = join(base, 'agents', 'cody')
  const projectRoot = join(base, 'agent-spaces')
  const aspHome = join(base, 'asp-home')
  mkdirSync(agentRoot, { recursive: true })
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(aspHome, { recursive: true })
  writeFileSync(
    join(agentRoot, 'agent-profile.toml'),
    `schemaVersion = 2

[spaces]
base = []

[brain]
enabled = false
`,
    'utf8'
  )
  createCodexShim(aspHome)
  return {
    agentRoot,
    projectRoot,
    aspHome,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

let fixture: ReturnType<typeof createFixture>
const originalCodexPath = process.env['ASP_CODEX_PATH']
const originalSkipCommon = process.env['ASP_CODEX_SKIP_COMMON_PATHS']

beforeAll(() => {
  fixture = createFixture()
  process.env['ASP_CODEX_PATH'] = join(fixture.aspHome, 'codex')
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = '1'
})

afterAll(() => {
  process.env['ASP_CODEX_PATH'] = originalCodexPath
  process.env['ASP_CODEX_SKIP_COMMON_PATHS'] = originalSkipCommon
  fixture.cleanup()
})

function baseCompileRequest(): RuntimeCompileRequest {
  const identity = allocatePreHrcRuntimeIdentity({
    namespace: 'prehrc_verifier',
    invocationId: 'inv_T01621',
    initialInputId: 'input_T01621',
    idempotencyKey: 'pre-hrc-broker-contract-verifier',
  })
  const placement = buildPlacementFromScopeRef({
    scopeRef: 'cody@agent-spaces',
    agentRoot: fixture.agentRoot,
    projectRoot: fixture.projectRoot,
    cwd: fixture.projectRoot,
    env: { OPENAI_API_KEY: SECRET_VALUE, EXTRA_FLAG: '1' },
    hostSessionId: identity.hostSessionId,
  })
  return {
    schemaVersion: 'agent-runtime-compile-request/v1',
    identity,
    placement,
    requested: {
      modelProvider: 'openai',
      model: 'gpt-5.5',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'headless',
    },
    materialization: {
      initialPrompt: 'hello contract verifier',
      taskContext: {
        taskId: 'T-01621',
        phase: 'green',
        role: 'curly',
        requiredEvidenceKinds: ['contract-artifacts'],
        hintsText: 'pre-HRC broker contract verifier',
      },
    },
    hrcPolicy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
      resourceLimits: { startupTimeoutMs: 10_000, turnTimeoutMs: 20_000 },
      observability: { traceId: identity.traceId },
      capabilityPolicy: {
        allowDegrade: false,
        requireBrokerDefaultForCodexHeadless: true,
      },
    },
    correlation: {
      requestId: identity.requestId,
      operationId: identity.operationId,
      hostSessionId: identity.hostSessionId,
      generation: identity.generation,
      runtimeId: identity.runtimeId,
      runId: identity.runId,
      invocationId: identity.invocationId,
      traceId: identity.traceId,
      appId: 'agent-spaces-tests',
      appSessionKey: 'pre-hrc-broker-contract-verifier',
      scopeRef: 'cody@agent-spaces',
      laneRef: 'main',
    },
  }
}

async function compilePlan(): Promise<CompiledRuntimePlan> {
  const client = createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
  const response = await client.compileRuntimePlan(baseCompileRequest())
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed: ${response.diagnostics.map((d) => d.code).join(', ')}`
    )
  }
  return response.plan
}

function brokerProfileOf(plan: CompiledRuntimePlan): BrokerExecutionProfile {
  return plan.executionProfiles.find(
    (profile): profile is BrokerExecutionProfile => profile.kind === 'harness-broker'
  )!
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function event(overrides: Partial<InvocationEventEnvelope> = {}): InvocationEventEnvelope {
  return {
    invocationId: 'inv_ledger',
    seq: 1,
    time: '2026-05-24T00:00:00.000Z',
    type: 'invocation.started',
    payload: { command: 'codex', args: ['app-server'], cwd: '/tmp' },
    ...overrides,
  } as InvocationEventEnvelope
}

function fakeBrokerProfile(
  overrides: Partial<BrokerExecutionProfile> = {}
): BrokerExecutionProfile {
  const profile = {
    schemaVersion: 'agent-runtime-profile/v1',
    profileId: 'profile_fake',
    profileHash: 'hash_fake',
    compatibilityHash: 'compat_fake',
    kind: 'harness-broker',
    interactionMode: 'headless',
    expectedCapabilities: {},
    redactedProfile: null,
    brokerProtocol: 'harness-broker/0.1',
    brokerDriver: 'codex-app-server',
    brokerOwnership: 'hrc-owned-process',
    harnessInvocation: {
      startRequest: {
        spec: {
          specVersion: 'harness-broker.invocation/v1',
          invocationId: 'inv_fake',
          harness: { frontend: 'codex', provider: 'openai', driver: 'codex-app-server' },
          process: {
            command: '/bin/codex',
            args: ['app-server'],
            cwd: '/tmp',
            env: {},
            harnessTransport: { kind: 'jsonrpc-stdio' },
          },
          driver: { kind: 'codex-app-server' },
        },
      },
      specHash: 'spec_fake',
      redactedSpecHash: 'rspec_fake',
      startRequestHash: 'sr_fake',
      redactedStartRequestHash: 'rsr_fake',
      redactedSpec: {
        specVersion: 'harness-broker.invocation/v1',
        redactionState: 'redacted',
        value: {},
      },
      redactedStartRequest: { redactionState: 'redacted', value: {} },
    },
    policy: {
      permissionPolicy: { mode: 'deny', audit: true },
      inputPolicy: DEFAULT_CODEX_BROKER_INPUT_POLICY,
      exposurePolicy: { mode: 'none' },
    },
    observability: {},
    ...overrides,
  }
  return profile as unknown as BrokerExecutionProfile
}

function fakePlan(
  profiles: BrokerExecutionProfile[],
  identity: { invocationId?: string; initialInputId?: string } = { invocationId: 'inv_fake' }
): CompiledRuntimePlan {
  return { executionProfiles: profiles, identity } as unknown as CompiledRuntimePlan
}

describe('allocatePreHrcRuntimeIdentity', () => {
  test('is deterministic for a given seed', () => {
    const seed = {
      namespace: 'prehrc_det',
      invocationId: 'inv_det',
      initialInputId: 'input_det',
      idempotencyKey: 'idem-det',
    }
    expect(allocatePreHrcRuntimeIdentity(seed)).toEqual(allocatePreHrcRuntimeIdentity(seed))
  })

  test('embeds the namespaced runtime ids and supplied invocation ids', () => {
    const identity = allocatePreHrcRuntimeIdentity({
      namespace: 'prehrc_contract',
      invocationId: 'inv_abc' as InvocationId,
      initialInputId: 'input_abc' as InputId,
    })
    expect(identity.requestId).toBe('request_prehrc_contract')
    expect(identity.operationId).toBe('runtimeOperation_prehrc_contract')
    expect(identity.hostSessionId).toBe('hostSession_prehrc_contract')
    expect(identity.runtimeId).toBe('runtime_prehrc_contract')
    expect(identity.runId).toBe('run_prehrc_contract')
    expect(identity.traceId).toBe('trace_prehrc_contract')
    expect(identity.generation).toBe(1)
    expect(identity.invocationId).toBe('inv_abc')
    expect(identity.initialInputId).toBe('input_abc')
  })

  test('omits initialInputId when withInitialInput is false', () => {
    const identity = allocatePreHrcRuntimeIdentity({
      invocationId: 'inv_no_input',
      withInitialInput: false,
    })
    expect(identity.initialInputId).toBeUndefined()
  })
})

describe('buildPlacementFromScopeRef', () => {
  test('derives agentName and bundle and preserves the raw scopeRef', () => {
    const placement = buildPlacementFromScopeRef({
      scopeRef: 'cody@agent-spaces',
      agentRoot: '/agents/cody',
      projectRoot: '/proj',
      env: { FOO: 'bar' },
      hostSessionId: 'hostSession_x',
    })
    expect(placement['agentRoot']).toBe('/agents/cody')
    expect(placement['projectRoot']).toBe('/proj')
    expect(placement['cwd']).toBe('/proj')
    expect(placement['runMode']).toBe('task')
    expect(placement['bundle']).toEqual({
      kind: 'agent-project',
      agentName: 'cody',
      projectRoot: '/proj',
    })
    expect((placement['correlation'] as Record<string, unknown>)['sessionRef']).toEqual({
      scopeRef: 'cody@agent-spaces',
      laneRef: 'main',
    })
    expect((placement['correlation'] as Record<string, unknown>)['hostSessionId']).toBe(
      'hostSession_x'
    )
  })
})

describe('selectBrokerProfile', () => {
  test('returns the compiled harness-broker profile from a real plan', async () => {
    const plan = await compilePlan()
    const selected = selectBrokerProfile(plan)
    expect(selected.kind).toBe('harness-broker')
    expect(selected.brokerDriver).toBe('codex-app-server')
    expect(selected.profileId).toBe(brokerProfileOf(plan).profileId)
  })

  test('selects by profileId and profileHash', async () => {
    const plan = await compilePlan()
    const target = brokerProfileOf(plan)
    expect(selectBrokerProfile(plan, { profileId: target.profileId }).profileId).toBe(
      target.profileId
    )
    expect(selectBrokerProfile(plan, { profileHash: target.profileHash }).profileHash).toBe(
      target.profileHash
    )
  })

  test('throws a structured failure when the selector matches nothing', async () => {
    const plan = await compilePlan()
    try {
      selectBrokerProfile(plan, { profileId: 'profile_does_not_exist' })
      throw new Error('expected selectBrokerProfile to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractHarnessFailureError)
      expect((error as ContractHarnessFailureError).failure.code).toBe('broker_profile_missing')
    }
  })

  test('throws when no harness-broker profile is present', () => {
    expect(() => selectBrokerProfile(fakePlan([]))).toThrow(ContractHarnessFailureError)
  })

  test('throws when the broker driver is not codex-app-server', () => {
    const bad = fakeBrokerProfile({ brokerDriver: 'some-other-driver' })
    try {
      selectBrokerProfile(fakePlan([bad]))
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractHarnessFailureError)
    }
  })

  test('throws when startRequest invocationId does not match identity', () => {
    const bad = fakeBrokerProfile()
    try {
      selectBrokerProfile(fakePlan([bad], { invocationId: 'inv_different' }))
      throw new Error('expected throw')
    } catch (error) {
      expect(error).toBeInstanceOf(ContractHarnessFailureError)
      expect((error as ContractHarnessFailureError).failure.code).toBe(
        'start_request_identity_mismatch'
      )
    }
  })
})

describe('verifyBrokerStartContract', () => {
  test('passes for an unmodified compiled profile and freezes the start request', async () => {
    const plan = await compilePlan()
    const profile = selectBrokerProfile(plan)
    const verification = verifyBrokerStartContract(profile)
    expect(verification.ok).toBe(true)
    expect(verification.failures).toHaveLength(0)
    expect(Object.isFrozen(profile.harnessInvocation.startRequest)).toBe(true)
    expect(Object.isFrozen(profile.harnessInvocation.startRequest.spec.process)).toBe(true)
  })

  test('FAILS when process.env was mutated after compile', async () => {
    const plan = await compilePlan()
    const profile = clone(selectBrokerProfile(plan))
    profile.harnessInvocation.startRequest.spec.process.env = {
      ...profile.harnessInvocation.startRequest.spec.process.env,
      INJECTED_AFTER_COMPILE: 'tampered',
    }
    const verification = verifyBrokerStartContract(profile)
    expect(verification.ok).toBe(false)
    const codes = verification.failures.map((f) => f.code)
    expect(codes).toContain('spec_hash_mismatch')
    expect(codes).toContain('start_request_hash_mismatch')
  })

  test('FAILS when initialInput.content was mutated after compile', async () => {
    const plan = await compilePlan()
    const profile = clone(selectBrokerProfile(plan))
    const initialInput = profile.harnessInvocation.startRequest.initialInput
    expect(initialInput).toBeDefined()
    initialInput!.content.push({ type: 'text', text: 'smuggled steering instruction' })
    const verification = verifyBrokerStartContract(profile)
    expect(verification.ok).toBe(false)
    const codes = verification.failures.map((f) => f.code)
    expect(codes).toContain('start_request_hash_mismatch')
    // spec is untouched, so only the start-request hash should drift.
    expect(codes).not.toContain('spec_hash_mismatch')
  })

  test('FAILS when spec.driver was mutated after compile', async () => {
    const plan = await compilePlan()
    const profile = clone(selectBrokerProfile(plan))
    ;(profile.harnessInvocation.startRequest.spec.driver as Record<string, unknown>)[
      'sandboxMode'
    ] = 'danger-full-access'
    const verification = verifyBrokerStartContract(profile)
    expect(verification.ok).toBe(false)
    expect(verification.failures.map((f) => f.code)).toContain('spec_hash_mismatch')
  })
})

describe('PreHrcBrokerEventLedger', () => {
  test('accepts identical duplicate seq idempotently and reports conflicting duplicates', () => {
    const ledger = new PreHrcBrokerEventLedger()
    const first = event()
    ledger.append(first)
    ledger.append(structuredClone(first))
    ledger.append(
      event({
        payload: { command: 'other-codex', args: ['app-server'], cwd: '/tmp' },
      })
    )

    expect(ledger.events()).toHaveLength(1)
    expect(ledger.requireNoDuplicates().map((failure) => failure.code)).toEqual([
      'broker_event_duplicate_conflict',
    ])
  })

  test('requires per-invocation seq monotonicity and normalized event types', () => {
    const ledger = new PreHrcBrokerEventLedger()
    ledger.append(event({ seq: 1 }))
    ledger.append(
      event({
        seq: 3,
        type: 'turn/started' as never,
        driver: { kind: 'codex', rawType: 'turn/started' },
      })
    )

    expect(ledger.requireMonotonicSeq().map((failure) => failure.code)).toEqual([
      'broker_event_seq_non_monotonic',
    ])
    expect(ledger.requireOnlyNormalizedEventTypes().map((failure) => failure.code)).toEqual([
      'broker_event_type_not_normalized',
    ])
  })
})

describe('runPreHrcBrokerContractHarness contract gate', () => {
  test('dry-run-compile passes the contract verifier and writes redacted artifacts', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'asp-prehrc-art-'))
    try {
      const result = await runPreHrcBrokerContractHarness({
        compileRequest: baseCompileRequest(),
        aspHome: fixture.aspHome,
        artifactDir,
        dryRunCompile: true,
      })
      expect(result.ok).toBe(true)
      expect(result.assertionReport.failures).toHaveLength(0)

      // Redacted artifacts must not contain the raw secret env value.
      const redacted = readFileSync(
        join(artifactDir, 'invocation-start-request.redacted.json'),
        'utf8'
      )
      expect(redacted).not.toContain(SECRET_VALUE)
      const plan = readFileSync(join(artifactDir, 'compiled-plan.redacted.json'), 'utf8')
      expect(plan).not.toContain(SECRET_VALUE)

      // RAW start request must NOT be written unless explicitly requested.
      expect(result.artifacts?.rawStartRequestWritten).toBe(false)
      expect(() =>
        readFileSync(join(artifactDir, 'invocation-start-request.RAW.UNSAFE.json'), 'utf8')
      ).toThrow()
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })

  test('reports a contract failure BEFORE broker start when the profile is mutated', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: baseCompileRequest(),
      aspHome: fixture.aspHome,
      dryRunCompile: false,
      mutateProfileForTest: (profile) => {
        profile.harnessInvocation.startRequest.spec.process.env = {
          ...profile.harnessInvocation.startRequest.spec.process.env,
          INJECTED_AFTER_COMPILE: 'tampered',
        }
      },
    })
    expect(result.ok).toBe(false)
    const codes = result.assertionReport.failures.map((f) => f.code)
    expect(codes).toContain('spec_hash_mismatch')
    // Broker start must not have been attempted; the gate fired first.
    expect(result.brokerStart?.attempted).toBe(false)
    expect(result.brokerStart).toEqual({
      attempted: false,
      reason: 'contract-verification-failed',
    })
    // The generic "not implemented" stub must NOT fire once the gate fails.
    expect(codes).not.toContain('broker_start_not_implemented')
  })

  test('broker-start passes the compiled start request unchanged through BrokerClient', async () => {
    const artifactDir = mkdtempSync(join(tmpdir(), 'asp-prehrc-broker-art-'))
    try {
      const result = await runPreHrcBrokerContractHarness({
        compileRequest: baseCompileRequest(),
        aspHome: fixture.aspHome,
        artifactDir,
        dryRunCompile: false,
        timeoutMs: 3000,
      })

      expect(result.ok).toBe(true)
      expect(result.assertionReport.failures).toHaveLength(0)
      expect(result.brokerStart?.attempted).toBe(true)
      if (result.brokerStart?.attempted !== true) {
        throw new Error('expected broker start to be attempted')
      }
      expect(result.brokerStart.response.invocationId).toBe('inv_T01621')
      expect(result.brokerStart.eventTypes).toContain('invocation.started')
      expect(result.brokerStart.eventTypes).toContain('turn.completed')
      expect(result.brokerStart.eventTypes).not.toContain('turn/started')
      expect(
        result.brokerStart.events.some(
          (brokerEvent) => brokerEvent.driver?.rawType === 'turn/started'
        )
      ).toBe(true)

      const eventJsonl = readFileSync(join(artifactDir, 'broker-events.jsonl'), 'utf8')
      expect(eventJsonl).toContain('"type":"turn.completed"')
      expect(eventJsonl).not.toContain('"type":"turn/started"')
    } finally {
      rmSync(artifactDir, { recursive: true, force: true })
    }
  })

  test('broker-start fails before scenario success when a required capability is missing', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: baseCompileRequest(),
      aspHome: fixture.aspHome,
      dryRunCompile: false,
      timeoutMs: 3000,
      mutateProfileForTest: (profile) => {
        profile.expectedCapabilities.turns.concurrency = 'multiple'
      },
    })

    expect(result.ok).toBe(false)
    expect(result.assertionReport.failures.map((failure) => failure.code)).toContain(
      'broker_capability_missing'
    )
    expect(result.brokerStart).toEqual({ attempted: false, reason: 'capability-missing' })
  })
})
