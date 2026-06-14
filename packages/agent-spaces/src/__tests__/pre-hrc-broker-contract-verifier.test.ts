/**
 * P2 helper-extraction + P3 contract-verifier coverage (pre-HRC plan §5.2–5.6).
 *
 * - selectBrokerProfile / allocatePreHrcRuntimeIdentity / buildPlacementFromScopeRef
 *   are the reusable named helpers P4/P7 consume.
 * - verifyBrokerStartContract is the compiler-closure gate that runs immediately
 *   before broker start: it recomputes specHash / startRequestHash and FAILS the
 *   run if local code mutated the selected start request after compile.
 */
import { afterAll, beforeAll, test as bunTest, describe, expect } from 'bun:test'
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
import { assertInteractiveTmuxLaunchClosure } from '../testing/pre-hrc-broker-contract-assertions.js'
import { runPreHrcBrokerContractHarness } from '../testing/pre-hrc-broker-contract-harness.js'
import { PreHrcBrokerEventLedger } from '../testing/pre-hrc-broker-event-ledger.js'
import {
  ContractHarnessFailureError,
  allocatePreHrcRuntimeIdentity,
  buildPlacementFromScopeRef,
  selectBrokerProfile,
  verifyBrokerStartContract,
} from '../testing/pre-hrc-broker-helpers.js'

type TestFn = () => unknown | Promise<unknown>

const HEAVY_TEST_TIMEOUT_MS = 60000

function test(name: string, fn: TestFn): void {
  bunTest(name, fn, HEAVY_TEST_TIMEOUT_MS)
}

type CompileClient = ReturnType<typeof createAgentSpacesClient> & {
  compileRuntimePlan(req: RuntimeCompileRequest): Promise<RuntimeCompileResponse>
}

const fakeCodexStartFreshTurn = new URL(
  '../../../harness-broker/test/fixtures/fake-codex/start-fresh-turn.ts',
  import.meta.url
).pathname

const fakeCodexPermissionRequest = new URL(
  '../../../harness-broker/test/fixtures/fake-codex/permission-request.ts',
  import.meta.url
).pathname

function createCodexShim(dir: string, fixturePath: string = fakeCodexStartFreshTurn): string {
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
  exec bun "${fixturePath}"
fi
echo "codex shim"
`,
    'utf8'
  )
  chmodSync(shimPath, 0o755)
  return shimPath
}

function createEnvCaptureCodexFixture(dir: string): string {
  const fixturePath = join(dir, 'env-capture.ts')
  const helperPath = new URL(
    '../../../harness-broker/src/testing/fake-codex-app-server.ts',
    import.meta.url
  ).pathname
  writeFileSync(
    fixturePath,
    `import {
  completeSimpleTurn,
  expectMethod,
  framed,
  initializeAndReadThreadRequest,
} from ${JSON.stringify(helperPath)}

const io = framed()
const thread = await initializeAndReadThreadRequest(io, 'thread/start')
io.respond(thread, { threadId: 'thread_env_capture' })
const turn = await expectMethod(io, 'turn/start')
const envCapture = {
  EXTRA_FLAG: process.env['EXTRA_FLAG'] ?? null,
  AGENT_SCOPE_REF: process.env['AGENT_SCOPE_REF'] ?? null,
  AGENT_LANE_REF: process.env['AGENT_LANE_REF'] ?? null,
  AGENT_HOST_SESSION_ID: process.env['AGENT_HOST_SESSION_ID'] ?? null,
}
completeSimpleTurn(io, 'ENV_CAPTURE:' + JSON.stringify(envCapture))
io.respond(turn, { ok: true })
`,
    'utf8'
  )
  return fixturePath
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
    lockedEnv: { EXTRA_FLAG: '1' },
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

function interactiveTmuxCompileRequest(): RuntimeCompileRequest {
  const base = baseCompileRequest()
  return {
    ...base,
    requested: {
      modelProvider: 'anthropic',
      model: 'claude-sonnet-4-5',
      harnessFamily: 'claude-code',
      preferredHarnessRuntime: 'claude-code-cli',
      interactionMode: 'interactive',
    },
    materialization: {
      ...base.materialization,
      initialPrompt: 'hello deterministic interactive tmux harness',
      attachments: [],
      taskContext: {
        taskId: 'T-01662',
        phase: 'red',
        role: 'smokey',
        requiredEvidenceKinds: ['red-test', 'green-test'],
        hintsText: 'pre-HRC interactive-tmux mode must own tmux and validate hook ledgers',
      },
    },
    hrcPolicy: {
      ...base.hrcPolicy,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    },
    continuation: undefined,
  }
}

function codexInteractiveTmuxCompileRequest(): RuntimeCompileRequest {
  const base = baseCompileRequest()
  return {
    ...base,
    requested: {
      modelProvider: 'openai',
      reasoningEffort: 'medium',
      harnessFamily: 'codex',
      preferredHarnessRuntime: 'codex-cli',
      interactionMode: 'interactive',
    },
    materialization: {
      ...base.materialization,
      initialPrompt: 'hello deterministic interactive codex tmux harness',
      attachments: [],
    },
    hrcPolicy: {
      ...base.hrcPolicy,
      exposurePolicy: { mode: 'broker-reports-target', targetKind: 'tmux-session' },
    },
    continuation: undefined,
  }
}

async function compileInteractiveTmuxProfile(
  request: RuntimeCompileRequest,
  driver: 'claude-code-tmux' | 'codex-cli-tmux'
): Promise<BrokerExecutionProfile> {
  const client = createAgentSpacesClient({ aspHome: fixture.aspHome }) as CompileClient
  const response = await client.compileRuntimePlan(request)
  if (!response.ok) {
    throw new Error(
      `compileRuntimePlan failed: ${response.diagnostics.map((d) => d.code).join(', ')}`
    )
  }
  const profile = response.plan.executionProfiles.find(
    (candidate): candidate is BrokerExecutionProfile =>
      candidate.kind === 'harness-broker' && candidate.brokerDriver === driver
  )
  if (profile === undefined) {
    throw new Error(`compile did not emit a ${driver} profile`)
  }
  return profile
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
    brokerProtocol: 'harness-broker/0.2',
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
            lockedEnv: {},
            harnessTransport: { kind: 'jsonrpc-stdio' },
          },
          driver: { kind: 'codex-app-server' },
        },
      },
      specHash: 'spec_fake',
      startRequestHash: 'sr_fake',
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

  test('FAILS when process.lockedEnv was mutated after compile', async () => {
    const plan = await compilePlan()
    const profile = clone(selectBrokerProfile(plan))
    profile.harnessInvocation.startRequest.spec.process.lockedEnv = {
      ...profile.harnessInvocation.startRequest.spec.process.lockedEnv,
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

  test('rejects the legacy permission event by default and tolerates it only with the transition flag', () => {
    const ledger = new PreHrcBrokerEventLedger()
    ledger.append(event({ seq: 1 }))
    ledger.append(
      event({
        seq: 2,
        type: 'invocation.permission.request' as never,
        driver: { kind: 'codex', rawType: 'invocation.permission.request' },
      })
    )

    expect(ledger.requireOnlyNormalizedEventTypes().map((failure) => failure.code)).toEqual([
      'broker_event_legacy_permission',
    ])
    expect(ledger.requireOnlyNormalizedEventTypes({ allowLegacyPermissionEvent: true })).toEqual([])
  })

  test('native Codex event names always fail even with the legacy permission flag set', () => {
    const ledger = new PreHrcBrokerEventLedger()
    ledger.append(event({ seq: 1 }))
    ledger.append(
      event({
        seq: 2,
        type: 'codex/event/agent_message' as never,
        driver: { kind: 'codex', rawType: 'codex/event/agent_message' },
      })
    )

    expect(
      ledger
        .requireOnlyNormalizedEventTypes({ allowLegacyPermissionEvent: true })
        .map((failure) => failure.code)
    ).toEqual(['broker_event_type_not_normalized'])
  })
})

describe('runPreHrcBrokerContractHarness contract gate', () => {
  test('dry-run-compile passes the contract verifier and writes projection artifacts', async () => {
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
      expect(
        result.selectedProfile?.harnessInvocation.startRequest.spec.interaction?.inputQueue
      ).toBe('fifo')
      expect(result.selectedProfile?.expectedCapabilities.input.queue).toBe('required')

      const startProjection = readFileSync(
        join(artifactDir, 'invocation-start-request.projection.json'),
        'utf8'
      )
      expect(startProjection).toContain('startRequestHash')
      const plan = readFileSync(join(artifactDir, 'compiled-plan.projection.json'), 'utf8')
      expect(plan).toContain('planHash')

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
        profile.harnessInvocation.startRequest.spec.process.lockedEnv = {
          ...profile.harnessInvocation.startRequest.spec.process.lockedEnv,
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

  test('reports a contract failure BEFORE broker start when initialInput.content is mutated', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: baseCompileRequest(),
      aspHome: fixture.aspHome,
      dryRunCompile: false,
      timeoutMs: 3000,
      mutateProfileForTest: (profile) => {
        const initialInput = profile.harnessInvocation.startRequest.initialInput
        if (initialInput === undefined) throw new Error('expected compiled initialInput')
        initialInput.content.push({ type: 'text', text: 'smuggled steering instruction' })
      },
    })
    expect(result.ok).toBe(false)
    const codes = result.assertionReport.failures.map((f) => f.code)
    // The start request drifted; spec is untouched so only the start-request hash moves.
    expect(codes).toContain('start_request_hash_mismatch')
    expect(codes).not.toContain('spec_hash_mismatch')
    // Broker start must not have been attempted; the closure gate fired first.
    expect(result.brokerStart).toEqual({
      attempted: false,
      reason: 'contract-verification-failed',
    })
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
      expect(result.brokerStart.response.capabilities.input.queue).toBe(true)
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

  test('broker-start spawns lockedEnv and dispatchEnv as a disjoint union', async () => {
    const envDir = mkdtempSync(join(tmpdir(), 'asp-prehrc-env-'))
    const previousCodexPath = process.env['ASP_CODEX_PATH']
    process.env['ASP_CODEX_PATH'] = createCodexShim(envDir, createEnvCaptureCodexFixture(envDir))
    try {
      const result = await runPreHrcBrokerContractHarness({
        compileRequest: baseCompileRequest(),
        aspHome: fixture.aspHome,
        dryRunCompile: false,
        timeoutMs: 3000,
      })

      expect(result.ok).toBe(true)
      expect(result.selectedProfile?.harnessInvocation.startRequest.spec.process.lockedEnv).toEqual(
        expect.objectContaining({ EXTRA_FLAG: '1' })
      )
      expect(
        result.selectedProfile?.harnessInvocation.startRequest.spec.process.lockedEnv
      ).not.toEqual(
        expect.objectContaining({
          AGENT_SCOPE_REF: expect.any(String),
          AGENT_LANE_REF: expect.any(String),
          AGENT_HOST_SESSION_ID: expect.any(String),
        })
      )

      if (result.brokerStart?.attempted !== true) {
        throw new Error('expected broker start to be attempted')
      }
      const terminalTurn = result.brokerStart.events.find(
        (event) => event.type === 'turn.completed'
      )
      const finalOutput = (terminalTurn?.payload as { finalOutput?: string } | undefined)
        ?.finalOutput
      expect(finalOutput?.startsWith('ENV_CAPTURE:')).toBe(true)
      const envCapture = JSON.parse(finalOutput?.slice('ENV_CAPTURE:'.length) ?? '{}') as Record<
        string,
        string | null
      >
      expect(envCapture).toEqual({
        EXTRA_FLAG: '1',
        AGENT_SCOPE_REF: 'cody@agent-spaces',
        AGENT_LANE_REF: 'main',
        AGENT_HOST_SESSION_ID: result.compileResponse.ok
          ? result.compileResponse.plan.identity.hostSessionId
          : null,
      })
    } finally {
      process.env['ASP_CODEX_PATH'] = previousCodexPath
      rmSync(envDir, { recursive: true, force: true })
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

  test('default permission mode is deny and the policy denial is audited in the event stream', async () => {
    // Repoint the fake Codex shim at a fixture that issues a command-approval
    // request mid-turn, so the broker's permission policy is actually exercised.
    const permDir = mkdtempSync(join(tmpdir(), 'asp-prehrc-perm-'))
    const artifactDir = mkdtempSync(join(tmpdir(), 'asp-prehrc-perm-art-'))
    const previousCodexPath = process.env['ASP_CODEX_PATH']
    process.env['ASP_CODEX_PATH'] = createCodexShim(permDir, fakeCodexPermissionRequest)
    try {
      const result = await runPreHrcBrokerContractHarness({
        compileRequest: baseCompileRequest(),
        aspHome: fixture.aspHome,
        artifactDir,
        dryRunCompile: false,
        timeoutMs: 5000,
      })

      expect(result.ok).toBe(true)
      // The compiled product policy defaults to deny + audited.
      expect(result.selectedProfile?.policy.permissionPolicy).toEqual({
        mode: 'deny',
        audit: true,
      })
      expect(result.routeDecision?.productPolicy.permissionPolicy).toEqual({
        mode: 'deny',
        audit: true,
      })

      if (result.brokerStart?.attempted !== true) {
        throw new Error('expected broker start to be attempted')
      }
      // The denial is audited as normalized permission events (decided by policy,
      // not forwarded to the client) and the turn still reaches a terminal state.
      const requested = result.brokerStart.events.find((e) => e.type === 'permission.requested')
      const resolved = result.brokerStart.events.find((e) => e.type === 'permission.resolved')
      expect(requested).toBeDefined()
      expect(resolved).toBeDefined()
      const resolution = resolved!.payload as { decision?: string; decidedBy?: string }
      expect(resolution.decision).toBe('deny')
      expect(resolution.decidedBy).toBe('policy')
      expect(result.brokerStart.eventTypes).toContain('turn.completed')
    } finally {
      process.env['ASP_CODEX_PATH'] = previousCodexPath
      rmSync(artifactDir, { recursive: true, force: true })
      rmSync(permDir, { recursive: true, force: true })
    }
  })

  test('interactive-tmux is a distinct mode and does not bend broker-start headless selection', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: interactiveTmuxCompileRequest(),
      aspHome: fixture.aspHome,
      mode: 'interactive-tmux',
      interactiveTmux: {
        socketPath: '/tmp/prehrc-interactive-tmux-mode.sock',
      },
    })

    expect(result.ok).toBe(true)
    expect(result.mode).toBe('interactive-tmux')
    expect(result.selectedProfile?.interactionMode).toBe('interactive')
    expect(result.selectedProfile?.brokerDriver).toBe('claude-code-tmux')
    expect(result.brokerStart?.attempted).toBe(true)
    expect(result.interactiveTmux?.attempted).toBe(true)
  })

  test('interactive-tmux owns tmux server lifecycle and supplies the runtime socket overlay', async () => {
    const socketPath = '/tmp/prehrc-interactive-tmux-owned.sock'
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: interactiveTmuxCompileRequest(),
      aspHome: fixture.aspHome,
      mode: 'interactive-tmux',
      interactiveTmux: { socketPath },
    })

    expect(result.ok).toBe(true)
    if (result.interactiveTmux?.attempted !== true) {
      throw new Error('expected interactive-tmux to be attempted')
    }
    expect(result.interactiveTmux.socketPath).toBe(socketPath)
    expect(result.interactiveTmux.tmuxServerEvents).toEqual([
      { owner: 'harness', action: 'start-server', socketPath },
      { owner: 'harness', action: 'new-session', socketPath },
      { owner: 'harness', action: 'kill-server', socketPath },
    ])
    expect(result.interactiveTmux.surface).toEqual({
      socketPath,
      sessionName: 'hrc-host-sessio',
      paneId: '%7',
    })

    // T-01727 Phase E: harness owns the tmux session lifecycle; the driver
    // consumes the leased pane and must NOT issue any server/session
    // lifecycle command itself.
    const driverCommands = result.interactiveTmux.driverTmuxArgv.flat()
    expect(driverCommands).not.toContain('start-server')
    expect(driverCommands).not.toContain('kill-server')
    expect(driverCommands).not.toContain('new-session')
    expect(driverCommands).not.toContain('kill-session')
  })

  test('interactive-tmux validates deterministic hook ledger ordering and clean exit', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: interactiveTmuxCompileRequest(),
      aspHome: fixture.aspHome,
      mode: 'interactive-tmux',
      interactiveTmux: {
        socketPath: '/tmp/prehrc-interactive-tmux-ledger.sock',
        includePermissionEvents: true,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.assertionReport.failures).toHaveLength(0)
    if (result.brokerStart?.attempted !== true || result.interactiveTmux?.attempted !== true) {
      throw new Error('expected interactive-tmux broker start')
    }

    const events = result.brokerStart.events
    const eventTypes = result.brokerStart.eventTypes
    const surfaceIndex = eventTypes.indexOf('terminal.surface.reported' as never)
    const inputTurnId = result.interactiveTmux.inputTurnId
    const turnStartedIndex = events.findIndex(
      (event) => event.type === 'turn.started' && event.turnId === inputTurnId
    )
    const terminalTurns = events.filter(
      (event) =>
        event.turnId === inputTurnId &&
        ['turn.completed', 'turn.failed', 'turn.interrupted'].includes(event.type)
    )

    expect(surfaceIndex).toBeGreaterThanOrEqual(0)
    expect(turnStartedIndex).toBeGreaterThan(surfaceIndex)
    expect(events[turnStartedIndex]?.payload).toEqual({ turnId: inputTurnId })
    expect(terminalTurns).toHaveLength(1)
    expect(terminalTurns[0]?.type).toBe('turn.completed')
    expect(eventTypes).not.toContain('invocation.permission.request' as never)
    expect(eventTypes).not.toContain('UserPromptSubmit' as never)
    expect(eventTypes).not.toContain('Stop' as never)

    const toolCompleted = events.find((event) => event.type === 'tool.call.completed')
    expect(toolCompleted?.driver?.rawType).toBe('PostToolUse')
    expect((toolCompleted?.payload as { isError?: boolean } | undefined)?.isError).toBe(true)
    expect(eventTypes).not.toContain('tool.call.failed')
    expect(eventTypes).toContain('permission.requested')
    expect(eventTypes).toContain('permission.resolved')
    expect(result.interactiveTmux.hookListenerClosed).toBe(true)
    expect(result.interactiveTmux.driverDisposed).toBe(true)
    expect(result.interactiveTmux.queuedInputLeft).toBe(false)
  })

  test('interactive-tmux drives turns 1 and 2 through broker input without a launch-prompt turn', async () => {
    const firstInput = 'drive deterministic interactive tmux turn 1'
    const secondInput = 'drive deterministic interactive tmux turn 2'
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: interactiveTmuxCompileRequest(),
      aspHome: fixture.aspHome,
      mode: 'interactive-tmux',
      interactiveTmux: {
        socketPath: '/tmp/prehrc-interactive-tmux-two-turns.sock',
        userInputText: firstInput,
        secondUserInputText: secondInput,
      },
    })

    expect(result.ok).toBe(true)
    if (result.brokerStart?.attempted !== true || result.interactiveTmux?.attempted !== true) {
      throw new Error('expected interactive-tmux broker start')
    }

    const turnIds = result.interactiveTmux.inputTurnIds ?? [result.interactiveTmux.inputTurnId]
    expect(turnIds).toHaveLength(2)
    for (const turnId of turnIds) {
      expect(result.brokerStart.events).toContainEqual(
        expect.objectContaining({ type: 'turn.started', turnId })
      )
      expect(result.brokerStart.events).toContainEqual(
        expect.objectContaining({ type: 'turn.completed', turnId })
      )
    }
    expect(result.brokerStart.events.filter((event) => event.type === 'turn.started')).toHaveLength(
      2
    )

    const literalTmuxInputs = result.interactiveTmux.driverTmuxArgv
      .filter((argv) => argv.includes('send-keys') && argv.includes('-l'))
      .map((argv) => argv.at(-1) ?? '')
    expect(literalTmuxInputs).toEqual(expect.arrayContaining([firstInput, secondInput]))
    // T-01746: the driver launches the harness via the real launch-runner module
    // against a JSON launch artifact. The staged paste buffer is
    // `exec bun <…/tmux-launch-runner.(ts|js)> --launch-file <…>.launch.json` —
    // confirm the launch send happened and that the initialPrompt did NOT leak
    // into the command line (the priming rides the launch argv inside the JSON
    // artifact, not a typed launch turn).
    const launchCommand = result.interactiveTmux.driverTmuxArgv
      .filter((argv) => argv.includes('set-buffer'))
      .map((argv) => argv.at(-1) ?? '')
      .find((text) =>
        /^exec bun \S*tmux-launch-runner\.(ts|js) --launch-file \S*\.launch\.json$/.test(text)
      )
    expect(launchCommand).toBeDefined()
    expect(launchCommand).not.toContain('hello deterministic interactive tmux harness')
  })

  test('interactive-tmux fails clean-exit assertions when queued input is left dirty', async () => {
    const result = await runPreHrcBrokerContractHarness({
      compileRequest: interactiveTmuxCompileRequest(),
      aspHome: fixture.aspHome,
      mode: 'interactive-tmux',
      interactiveTmux: {
        socketPath: '/tmp/prehrc-interactive-tmux-dirty-queue.sock',
        simulateQueuedInputLeftForTest: true,
      },
    })

    expect(result.ok).toBe(false)
    expect(result.assertionReport.failures.map((failure) => failure.code)).toContain(
      'interactive_tmux_clean_exit_invalid'
    )
  })
})

describe('interactive tmux launch closure (T-01746)', () => {
  // Per pre-HRC conformance, the launch-header / priming-via-launch-argv contract
  // is required for EVERY interactive tmux row, so assert it for both drivers.
  test('claude-code-tmux carries spec.launch and no typed initialInput', async () => {
    const profile = await compileInteractiveTmuxProfile(
      interactiveTmuxCompileRequest(),
      'claude-code-tmux'
    )
    expect(assertInteractiveTmuxLaunchClosure(profile)).toEqual([])
    const launch = profile.harnessInvocation.startRequest.spec.launch
    expect(launch?.initialPrompt).toBe('hello deterministic interactive tmux harness')
    expect(profile.harnessInvocation.startRequest.initialInput).toBeUndefined()
  })

  test('codex-cli-tmux carries spec.launch and no typed initialInput', async () => {
    const profile = await compileInteractiveTmuxProfile(
      codexInteractiveTmuxCompileRequest(),
      'codex-cli-tmux'
    )
    expect(assertInteractiveTmuxLaunchClosure(profile)).toEqual([])
    const launch = profile.harnessInvocation.startRequest.spec.launch
    expect(launch?.initialPrompt).toBe('hello deterministic interactive codex tmux harness')
    expect(profile.harnessInvocation.startRequest.initialInput).toBeUndefined()
  })

  test('FAILS when an interactive tmux profile reintroduces a typed initialInput', async () => {
    const profile = await compileInteractiveTmuxProfile(
      interactiveTmuxCompileRequest(),
      'claude-code-tmux'
    )
    const mutated = {
      ...profile,
      harnessInvocation: {
        ...profile.harnessInvocation,
        startRequest: {
          ...profile.harnessInvocation.startRequest,
          initialInput: {
            inputId: 'input_typed' as InputId,
            kind: 'user' as const,
            content: [{ type: 'text' as const, text: 'typed priming' }],
          },
        },
      },
    } as BrokerExecutionProfile
    expect(assertInteractiveTmuxLaunchClosure(mutated).map((f) => f.code)).toContain(
      'launch_initial_input_present'
    )
  })

  test('FAILS when spec.launch no longer carries the priming', async () => {
    const profile = await compileInteractiveTmuxProfile(
      codexInteractiveTmuxCompileRequest(),
      'codex-cli-tmux'
    )
    const mutated = {
      ...profile,
      harnessInvocation: {
        ...profile.harnessInvocation,
        startRequest: {
          ...profile.harnessInvocation.startRequest,
          spec: { ...profile.harnessInvocation.startRequest.spec, launch: undefined },
        },
      },
    } as BrokerExecutionProfile
    expect(assertInteractiveTmuxLaunchClosure(mutated).map((f) => f.code)).toContain(
      'launch_priming_missing'
    )
  })
})
